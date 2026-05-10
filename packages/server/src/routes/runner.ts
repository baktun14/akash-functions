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
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/client';
import { apiKeys, deployments, functionVariables, functionVersions, functions } from '../db/schema';
import { secrets } from '../lib/secrets';
import { verifyToken } from '../lib/signing';
import { log } from '../lib/log';
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
    for (const [relPath, contents] of Object.entries(version.source)) {
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

  const [version] = await db
    .select({
      id: functionVersions.id,
      createdAt: functionVersions.createdAt,
      source: functionVersions.source,
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

  const detected = extractRoutes(version.source) ?? [];
  const routes = decorateRoutesWithAuth(detected, fn.protectedRoutes);

  c.header('Cache-Control', 'no-store');
  return c.json({
    versionId: version.id,
    updatedAt: version.createdAt.toISOString(),
    variablesRevision: fn.variablesRevision,
    apiKeyHashes: keyHashes,
    routes,
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
  const message = body.ok ? null : formatHealthError(body);

  // Update whichever non-terminal deployment is open for this function. The
  // runner's versionId is informational — a deployment row carries the lease,
  // not the version, and the runner hot-reloads new versions onto the same
  // lease.
  const updated = await db
    .update(deployments)
    .set({ errorMessage: message })
    .where(
      and(
        eq(deployments.functionId, fnId),
        isNull(deployments.closedAt),
        ne(deployments.state, 'failed')
      )
    )
    .returning({ id: deployments.id });

  if (!body.ok) {
    log.warn('runner reported unhealthy probe', {
      fnId,
      versionId: body.versionId,
      status: body.status,
      updatedRows: updated.length,
    });
  }

  return c.json({ updated: updated.length });
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
