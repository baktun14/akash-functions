// /api/runner/* — endpoints the runner image calls back into.
//
// /code/:fnId/:versionId   returns a tarball of the source. Accepts a runner
//                          or code token (the runner image polls this whenever
//                          it sees a new version).
// /current/:fnId           returns { versionId, updatedAt } for the latest
//                          version. Polled by the runner every POLL_INTERVAL_MS.
// /health/:fnId            runner reports the result of an HTTP probe against
//                          the user code. We use it to surface "function
//                          deployed but every request 500s" on the dashboard.
//
// Auth is the HMAC token in the `t` query param or `Authorization: Bearer`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/client';
import { apiKeys, deployments, functionVariables, functionVersions, functions, runLogs } from '../db/schema';
import { secrets } from '../lib/secrets';
import { readSource } from '../lib/source';
import { verifyToken } from '../lib/signing';
import { log } from '../lib/log';
import { requestTeardown } from '../akash/teardown';
import { decorateRoutesWithAuth } from './deploy';
import { extractRoutes } from './extract-routes';

export const runnerRouter = new Hono();

function extractToken(c: Context): string {
  const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
  const headerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : undefined;
  const token = c.req.query('t') ?? headerToken;
  if (!token) throw new HTTPException(401, { message: 'Missing token' });
  return token;
}

// Public — no auth middleware. Verification happens on the HMAC token.
runnerRouter.get('/code/:fnId/:versionId', async (c) => {
  const fnId = c.req.param('fnId');
  const versionId = c.req.param('versionId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, versionId, allowKinds: ['runner', 'code'] });
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const [version] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.id, versionId))
    .limit(1);
  if (!version || version.functionId !== fnId) {
    throw new HTTPException(404, { message: 'Version not found' });
  }

  // Materialize source files into a tmp dir, then `tar -cz` it.
  const dir = await mkdtemp(path.join(tmpdir(), 'fn-'));
  try {
    const source = readSource(version);
    for (const [relPath, contents] of Object.entries(source)) {
      const safeRel = sanitizeRelPath(relPath);
      const target = path.join(dir, safeRel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }

    const tarball = await tarGzip(dir);
    const body = new Blob([new Uint8Array(tarball)], { type: 'application/gzip' });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${fnId}-${versionId}.tar.gz"`,
      },
    });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Latest version pointer for a function. The runner polls this on its
// POLL_INTERVAL_MS cadence; on a change to versionId it fetches
// /code/:fnId/:newVersionId and hot-swaps /app. On a change to
// variablesRevision it fetches /env/:fnId and respawns the user process
// with the new env (no code re-fetch).
runnerRouter.get('/current/:fnId', async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    log.warn('runner token rejected', { fnId, reason: verified.reason, path: c.req.path });
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  // 404 if the function was deleted (tombstoned). The runner uses this as a
  // signal to exit cleanly so the Akash provider can release the lease.
  const [fn] = await db
    .select({
      id: functions.id,
      walletAddress: functions.walletAddress,
      variablesRevision: functions.variablesRevision,
      protectedRoutes: functions.protectedRoutes,
    })
    .from(functions)
    .where(and(eq(functions.id, fnId), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  // Runner self-reports its version via `?v=…`. We stamp `runnerSeenAt` on
  // every poll because it doubles as the liveness signal that drives the
  // auto-rebind sweep (see isRunnerStale) — gating it behind a version-
  // changed guard would mean a long-lived deployment never refreshes the
  // timestamp and looks permanently stranded. One update per ~10s per
  // deployment is negligible at this scale.
  // `d=<deploymentId>` is set by JOB runners so the heartbeat stamps only THIS
  // run's row (concurrent runs are allowed — D6) and we can compute a per-run
  // `terminal` flag. Service runners omit it and keep the fn-wide stamp.
  const deploymentParam = c.req.query('d');
  const reportedVersion = c.req.query('v');
  if (reportedVersion && /^\d+\.\d+\.\d+/.test(reportedVersion)) {
    await db
      .update(deployments)
      .set({ runnerVersion: reportedVersion, runnerSeenAt: new Date() })
      .where(
        deploymentParam
          ? and(eq(deployments.id, deploymentParam), eq(deployments.functionId, fnId))
          : and(eq(deployments.functionId, fnId), ne(deployments.state, 'closed'))
      );
  }

  // Terminal guard (D2): a job runner asks, on boot/restart, whether its run is
  // already finished — if so it idles instead of re-running the script. A run is
  // terminal once it has a run_outcome or its lease is closed/failed.
  let terminal = false;
  if (deploymentParam) {
    const [dep] = await db
      .select({ runOutcome: deployments.runOutcome, state: deployments.state })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentParam), eq(deployments.functionId, fnId)))
      .limit(1);
    terminal = !!dep && (dep.runOutcome != null || dep.state === 'closed' || dep.state === 'failed');
  }

  const [version] = await db
    .select({
      id: functionVersions.id,
      createdAt: functionVersions.createdAt,
      sourceCiphertext: functionVersions.sourceCiphertext,
      sourceIv: functionVersions.sourceIv,
      sourceAuthTag: functionVersions.sourceAuthTag,
      sourceKeyVersion: functionVersions.sourceKeyVersion,
    })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, fnId))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);
  if (!version) throw new HTTPException(404, { message: 'No versions for function' });

  // Auth payload for the runner sidecar's reverse proxy:
  //  - apiKeyHashes: full SHA-256 hex of every active key on this wallet.
  //    Replaced wholesale on each poll, so revocation takes effect within
  //    one poll interval.
  //  - routes: the auto-detected route list, decorated with auth='apiKey'
  //    for any entry that appears in the function's protected_routes set.
  // walletAddress can be null on legacy rows during the wallet migration; in
  // that case there are no keys and any protected route 401s every caller.
  const keyHashes: string[] = fn.walletAddress
    ? (
        await db
          .select({ keyHash: apiKeys.keyHash })
          .from(apiKeys)
          .where(eq(apiKeys.walletAddress, fn.walletAddress))
      ).map((row) => row.keyHash)
    : [];

  const detected = extractRoutes(readSource(version)) ?? [];
  const routes = decorateRoutesWithAuth(detected, fn.protectedRoutes);

  c.header('Cache-Control', 'no-store');
  return c.json({
    versionId: version.id,
    updatedAt: version.createdAt.toISOString(),
    variablesRevision: fn.variablesRevision,
    apiKeyHashes: keyHashes,
    routes,
    terminal,
  });
});

// Plaintext env vars for the runner to inject into the user process. This is
// the ONLY route that emits decrypted variable values; it requires the
// long-lived runner-kind HMAC scoped to fnId. Never logs values. The runner
// fetches this at boot and again whenever it sees variablesRevision change
// on /current/:fnId.
runnerRouter.get('/env/:fnId', async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    log.warn('runner token rejected', { fnId, reason: verified.reason, path: c.req.path });
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const [fn] = await db
    .select({ id: functions.id, variablesRevision: functions.variablesRevision })
    .from(functions)
    .where(and(eq(functions.id, fnId), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const rows = await db
    .select({
      key: functionVariables.key,
      ciphertext: functionVariables.ciphertext,
      iv: functionVariables.iv,
      authTag: functionVariables.authTag,
      keyVersion: functionVariables.keyVersion,
    })
    .from(functionVariables)
    .where(eq(functionVariables.functionId, fnId));

  const envOut: Record<string, string> = {};
  for (const row of rows) {
    try {
      envOut[row.key] = secrets.decrypt({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      });
    } catch (err) {
      // A single bad row shouldn't tank the whole response. Log structured
      // error (no value) and skip the row so the runner still gets the rest.
      log.error('decrypt failed for function variable', {
        fnId,
        key: row.key,
        keyVersion: row.keyVersion,
        err: String(err),
      });
    }
  }

  log.info('runner env served', {
    fnId,
    revision: fn.variablesRevision,
    keys: Object.keys(envOut).length,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    variablesRevision: fn.variablesRevision,
    env: envOut,
  });
});

// Runner reports the outcome of a one-shot HTTP probe against the user's
// process after each successful spawn. We translate that into the open
// deployment's errorMessage so the dashboard can show "your function listens,
// but the first request to / threw" without operators having to dig through
// provider lease-logs.
const HealthBody = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    versionId: z.string().uuid(),
    status: z.number().int().min(0).max(599),
  }),
  z.object({
    ok: z.literal(false),
    versionId: z.string().uuid(),
    status: z.number().int().min(0).max(599),
    statusText: z.string().max(128).optional(),
    bodyExcerpt: z.string().max(2048).optional(),
    reason: z.string().max(256).optional(),
    // Runner only sets this when the user-code child process exited and won't
    // recover on its own. Distinguishes a working-but-buggy function (yellow
    // banner, errorMessage only) from a crashed-at-boot function (red banner,
    // state='failed') and gates the recovery transition on the next ok report.
    fatal: z.boolean().optional(),
  }),
]);
type HealthInput = z.infer<typeof HealthBody>;

const ERROR_MESSAGE_MAX = 1000;
const CONTROL_CHARS = /[ --]/g;

function formatHealthError(input: Extract<HealthInput, { ok: false }>): string {
  const head =
    input.status > 0
      ? `Function returned ${input.status}${input.statusText ? ` ${input.statusText}` : ''}`
      : `Function did not respond on probe${input.reason ? ` (${input.reason})` : ''}`;
  const excerpt = input.bodyExcerpt?.replace(CONTROL_CHARS, '').trim();
  const full = excerpt ? `${head}: ${excerpt}` : head;
  return full.length > ERROR_MESSAGE_MAX ? `${full.slice(0, ERROR_MESSAGE_MAX - 1)}…` : full;
}

runnerRouter.post('/health/:fnId', zValidator('json', HealthBody), async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    log.warn('runner token rejected', { fnId, reason: verified.reason, path: c.req.path });
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const body = c.req.valid('json');

  // Three branches:
  //   ok        → clear errorMessage AND lift state out of 'failed' if the
  //               runner just hot-reloaded a fix on top of a crashed child.
  //   fatal     → child crashed and won't recover until the next reload. Mark
  //               state='failed' so the dashboard shows the red error banner
  //               and the reconciler stops probing ingress (which would 503
  //               and eventually close the row).
  //   non-fatal → existing behavior: live function responded 5xx on probe,
  //               yellow "Runtime error on first request" banner.
  // `versionId` in the body is the version the runner just spawned. /health
  // fires after a successful spawn/probe, so it's the only point at which we
  // know which version is *actually running* (vs. /current, which just tells
  // the runner what to download next). Persisting it here keeps
  // deployments.version_id aligned with reality across reloads.
  // Stamp runnerSeenAt on every health report too (in addition to /current),
  // so a service runner that reports health but missed a poll window still
  // looks alive to the staleness check.
  const seenAt = new Date();
  let updated: { id: string }[];
  if (body.ok) {
    updated = await db
      .update(deployments)
      .set({
        versionId: body.versionId,
        errorMessage: null,
        runnerSeenAt: seenAt,
        state: sql`CASE WHEN ${deployments.state} = 'failed' THEN 'live' ELSE ${deployments.state} END`,
      })
      .where(and(eq(deployments.functionId, fnId), isNull(deployments.closedAt)))
      .returning({ id: deployments.id });
  } else if (body.fatal) {
    updated = await db
      .update(deployments)
      .set({ versionId: body.versionId, state: 'failed', errorMessage: formatHealthError(body), runnerSeenAt: seenAt })
      .where(and(eq(deployments.functionId, fnId), isNull(deployments.closedAt)))
      .returning({ id: deployments.id });
  } else {
    updated = await db
      .update(deployments)
      .set({ versionId: body.versionId, errorMessage: formatHealthError(body), runnerSeenAt: seenAt })
      .where(
        and(
          eq(deployments.functionId, fnId),
          isNull(deployments.closedAt),
          ne(deployments.state, 'failed')
        )
      )
      .returning({ id: deployments.id });
  }

  if (!body.ok) {
    log.warn('runner reported unhealthy probe', {
      fnId,
      versionId: body.versionId,
      status: body.status,
      fatal: body.fatal === true,
      updatedRows: updated.length,
    });
  }

  return c.json({ updated: updated.length });
});

// ── Job (Python-run) terminal report (D4 + D1) ──
//
// The SOLE reliable terminal signal for a job. Distinct from /health on purpose:
// /health's fatal branch sets state='failed' (crash semantics), but a clean job
// exit is success, not a crash. This endpoint is the only writer of run_outcome
// + exit_code + finished_at, is idempotent (re-POST after a retry is a no-op),
// and fires the autonomous teardown driver (D1) so the lease closes within
// seconds with no browser open. Teardown NEVER touches run_outcome (D4).
const CompleteBody = z.object({
  deploymentId: z.string().uuid(),
  versionId: z.string().uuid(),
  exitCode: z.number().int().min(-256).max(255),
  phase: z.enum(['run', 'install', 'no-entry', 'spawn', 'gpu-unavailable']),
  reason: z.string().max(512).optional(),
  finishedAt: z.string().datetime().optional(),
});

runnerRouter.post('/complete/:fnId', zValidator('json', CompleteBody), async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    log.warn('runner token rejected', { fnId, reason: verified.reason, path: c.req.path });
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const body = c.req.valid('json');
  const succeeded = body.phase === 'run' && body.exitCode === 0;
  const runOutcome = succeeded ? 'succeeded' : 'failed';
  const finishedAt = body.finishedAt ? new Date(body.finishedAt) : new Date();
  const errorMessage = succeeded
    ? null
    : completeErrorMessage(body.phase, body.exitCode, body.reason);

  // Idempotent: only the FIRST terminal report wins (run_outcome still null).
  // A retried POST or a racing cancel leaves the durable result untouched.
  const updated = await db
    .update(deployments)
    .set({
      versionId: body.versionId,
      runOutcome,
      exitCode: body.exitCode,
      finishedAt,
      errorMessage,
      teardownState: 'requested',
    })
    .where(
      and(
        eq(deployments.id, body.deploymentId),
        eq(deployments.functionId, fnId),
        isNull(deployments.runOutcome)
      )
    )
    .returning({ id: deployments.id });

  // Fire teardown whether or not this was the first report — a retry that finds
  // run_outcome already set still needs the lease gone (the prior teardown may
  // have failed). requestTeardown is idempotent (CAS on teardown_state).
  void requestTeardown(body.deploymentId);

  log.info('job complete', {
    fnId,
    deploymentId: body.deploymentId,
    phase: body.phase,
    exitCode: body.exitCode,
    runOutcome,
    firstReport: updated.length > 0,
  });
  return c.json({ ok: true, firstReport: updated.length > 0 });
});

function completeErrorMessage(phase: string, exitCode: number, reason?: string): string {
  const head =
    phase === 'install'
      ? `Dependency install failed (exit ${exitCode})`
      : phase === 'no-entry'
        ? 'No Python entry point found (expected main.py)'
        : phase === 'spawn'
          ? 'Failed to start the Python process'
          : phase === 'gpu-unavailable'
            ? 'GPU not visible on this provider (torch.cuda.is_available() was false)'
            : `Script exited with code ${exitCode}`;
  const full = reason ? `${head}: ${reason}` : head;
  return full.length > ERROR_MESSAGE_MAX ? `${full.slice(0, ERROR_MESSAGE_MAX - 1)}…` : full;
}

// ── Job log ingest ──
//
// Batched, at-least-once stream of stdout/stderr chunks. seq is monotonic per
// (deployment, shard); the unique index dedupes retried POSTs. Logs are
// lossy/best-effort — the exit code rides /complete, never this channel.
const LogsBody = z.object({
  deploymentId: z.string().uuid(),
  baseSeq: z.number().int().min(0),
  shardIndex: z.number().int().min(0).default(0),
  chunks: z
    .array(
      z.object({
        stream: z.enum(['stdout', 'stderr']),
        text: z.string().max(64 * 1024),
        ts: z.string().datetime().optional(),
      })
    )
    .max(2048),
});

// Soft cap on persisted log rows per run, so a runaway logger can't unbound the
// table. Past the cap we drop new chunks (the runner still has them in pod logs)
// — a one-time truncation sentinel marks the gap.
const RUN_LOG_MAX_ROWS = 200_000;

runnerRouter.post('/logs/:fnId', zValidator('json', LogsBody), async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const body = c.req.valid('json');
  if (body.chunks.length === 0) return c.body(null, 204);

  // Scope check: the deployment must belong to this function.
  const [dep] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.id, body.deploymentId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Deployment not found for function' });

  const rows = body.chunks.map((ch, i) => ({
    deploymentId: body.deploymentId,
    seq: body.baseSeq + i,
    stream: ch.stream,
    chunk: ch.text,
    shardIndex: body.shardIndex,
    ts: ch.ts ? new Date(ch.ts) : new Date(),
  }));

  // onConflictDoNothing on the (deployment, shard, seq) unique index = retry
  // dedupe. Best-effort; a failed insert just means the runner retries.
  await db.insert(runLogs).values(rows).onConflictDoNothing();

  return c.body(null, 204);
});

function sanitizeRelPath(p: string): string {
  // Strip leading slashes and "..", normalise separators, prevent path traversal.
  const cleaned = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new HTTPException(400, { message: `Invalid path in source: ${p}` });
  }
  return cleaned;
}

function tarGzip(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', '-', '-C', dir, '.']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
