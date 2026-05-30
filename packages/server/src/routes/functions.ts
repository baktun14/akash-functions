// /api/functions — CRUD for function records and their version history.

import { and, desc, eq, isNull, like, notInArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type {
  FunctionRecord,
  FunctionVariablesResponse,
  FunctionVersionDetail,
  FunctionVersionSummary,
  PresetId,
  ProtectedRoutesResponse,
  PutFunctionVariableResponse,
  RunOutcome,
} from '@shared/types';
import { validateVariableKey } from '@shared/reserved-vars';
import { ConsoleApiError, consoleApi } from '../akash/console-client';
import { startDeployPipeline } from '../akash/pipeline';
import { evictWalletKeyIfIdle } from '../akash/key-cache';
import { drainPendingTeardowns } from '../akash/teardown';
import { rebuildAndUpdateSdl } from '../akash/rebind';
import { buildSdl } from '../akash/sdl';
import { db } from '../db/client';
import { deployments, functionVariables, functionVersions, functions } from '../db/schema';
import { env } from '../env';
import { secrets } from '../lib/secrets';
import { encryptedSourceColumns, readSource } from '../lib/source';
import { isRunnerOutdated, isRunnerStale } from '../lib/runner-version';
import { signRunner } from '../lib/signing';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

const GpuSchema = z.object({
  vendor: z.enum(['nvidia', 'amd']),
  model: z.string().min(1).max(40),
  units: z.number().int().positive().max(8).optional(),
});

const ResourceSchema = z.object({
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
  gpu: GpuSchema.optional(),
});

// Per-file 1MB cap, plus total-size cap of 5MB to keep JSONB rows reasonable.
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 5_000_000;
const SourceMapSchema = z
  .record(z.string(), z.string().max(MAX_FILE_BYTES, 'file too large (max 1MB)'))
  .refine(
    (m) => Object.values(m).reduce((n, s) => n + s.length, 0) <= MAX_TOTAL_BYTES,
    { message: 'source map too large (max 5MB total)' }
  );

const CreateBody = z.object({
  name: z.string().min(1).max(60),
  preset: z.enum(['rest', 'jsx', 'cron', 'gpu']),
  prompt: z.string().optional(),
  source: SourceMapSchema,
  resources: ResourceSchema,
  envVars: z.record(z.string(), z.string()).optional(),
});

const UpdateNameBody = z.object({ name: z.string().min(1).max(60) });

const UpdateCodeBody = z.object({
  source: SourceMapSchema,
  message: z.string().max(200).optional(),
  resources: ResourceSchema.optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});

const RestoreBody = z.object({
  message: z.string().max(200).optional(),
});

export const functionsRouter = new Hono<{ Variables: AuthVars }>();

functionsRouter.use('*', requireAkashKey);

functionsRouter.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const rows = await db
    .select()
    .from(functions)
    .where(and(eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .orderBy(desc(functions.createdAt));

  // Decorate with the latest deployment URI so the frontend can show it
  // straight away in the cards list.
  const decorated = await Promise.all(
    rows.map(async (fn) => ({ fn, dep: await latestDeployment(fn.id) }))
  );

  const list: FunctionRecord[] = decorated.map(({ fn, dep }) => {
    const isJob = fn.executionKind === 'job';
    return {
      id: fn.id,
      name: fn.name,
      kind: isJob ? ('python-job' as const) : ('function' as const),
      // Jobs have no ingress URL (D6).
      ingressUrl: isJob ? undefined : dep?.uris?.[0],
      image: isJob ? env.PYTHON_RUNNER_IMAGE : env.RUNNER_IMAGE,
      status: dep ? stateToStatus(dep.state, dep.errorMessage) : 'idle',
      latestDeploymentId: dep?.id,
      // Job cards show the latest run's outcome instead of runner nudges (D6).
      ...(isJob
        ? {
            runOutcome: (dep?.runOutcome as RunOutcome | null) ?? undefined,
            exitCode: dep?.exitCode ?? undefined,
            runnerOutdated: false,
            runnerStale: false,
          }
        : {
            // Only flag live deployments; functions that are idle/pending/
            // failed/closed either have no runner running or are mid-transition,
            // so an "outdated" badge would be noise.
            runnerOutdated:
              dep?.state === 'live' ? isRunnerOutdated(dep.runnerVersion, dep.liveAt) : false,
            runnerStale: dep ? isRunnerStale(dep.runnerSeenAt, dep.liveAt, dep.state) : false,
          }),
    };
  });

  // Fallback teardown drain (D1): retry any job lease stuck in
  // teardown_state='requested' using THIS request's fresh Console key — covers
  // the rotated-cached-key case. Fire-and-forget.
  void drainPendingTeardowns(akashKey);

  // Fire-and-forget: cross-check on-chain state for any deployment we still
  // believe is live/leased. The reconciler can't do this (no apiKey outside
  // an authed request), so we piggyback on the user's poll. Updates land in
  // the DB and the frontend's next 3s/30s tick reflects them.
  void crossCheckAkashStates(akashKey, walletAddress, decorated.map((d) => d.dep));

  // Same piggyback for auto-rebind: if a live runner has gone silent on the
  // poll loop (almost always because BACKEND_BASE_URL is stale — e.g. dev
  // tunnel rotated), submit a fresh SDL on the same lease so the provider
  // re-pulls with the current env.CODE_HOST_BASE. Cooldown is per-deployment
  // (see autoRebindStaleRunners) so we never thrash the same lease if rebind
  // alone doesn't cure the silence.
  void autoRebindStaleRunners(akashKey, decorated.map((d) => d.dep));

  return c.json(list);
});

async function crossCheckAkashStates(
  akashKey: string,
  walletAddress: string,
  deps: Array<Awaited<ReturnType<typeof latestDeployment>>>
): Promise<void> {
  const candidates = deps.filter(
    (d): d is NonNullable<typeof d> & { dseq: string } =>
      !!d && !!d.dseq && (d.state === 'live' || d.state === 'leased')
  );

  await Promise.allSettled([
    ...candidates.map(async (dep) => {
      try {
        const detail = await consoleApi.getDeployment(akashKey, dep.dseq);
        const deploymentClosed = detail.deployment?.state === 'closed';
        const allLeasesClosed =
          Array.isArray(detail.leases) &&
          detail.leases.length > 0 &&
          detail.leases.every((l) => l.state === 'closed');
        if (deploymentClosed || allLeasesClosed) {
          await markClosedOnChain(dep.id, 'lease no longer active on-chain');
        }
      } catch (err) {
        if (err instanceof ConsoleApiError && err.status === 404) {
          await markClosedOnChain(dep.id, 'deployment not found on-chain');
          return;
        }
        log.warn('akash state cross-check failed', {
          deploymentId: dep.id,
          dseq: dep.dseq,
          err: String(err),
        });
      }
    }),
    rehydrateProbeClosed(akashKey, walletAddress),
  ]);
}

// Recovery: rows we wrongly closed from an ingress probe in a prior version
// of the reconciler. If the on-chain lease is still active, restore them to
// 'live'. Lets the dashboard self-heal after a transient outbound-network
// blip on the server, without the user having to redeploy.
async function rehydrateProbeClosed(akashKey: string, walletAddress: string): Promise<void> {
  // Scope to this wallet's deployments so one user's poll can't fan out a
  // Console lookup over every other wallet's history.
  const wrongfullyClosed = await db
    .select({
      id: deployments.id,
      dseq: deployments.dseq,
    })
    .from(deployments)
    .innerJoin(functions, eq(functions.id, deployments.functionId))
    .where(and(
      eq(functions.walletAddress, walletAddress),
      eq(deployments.state, 'closed'),
      like(deployments.errorMessage, 'ingress unreachable%')
    ))
    .limit(50);

  if (wrongfullyClosed.length === 0) return;

  await Promise.allSettled(wrongfullyClosed.map(async (dep) => {
    if (!dep.dseq) return;
    try {
      const detail = await consoleApi.getDeployment(akashKey, dep.dseq);
      const deploymentClosed = detail.deployment?.state === 'closed';
      const allLeasesClosed =
        Array.isArray(detail.leases) &&
        detail.leases.length > 0 &&
        detail.leases.every((l) => l.state === 'closed');
      if (deploymentClosed || allLeasesClosed) return;
      const updated = await db
        .update(deployments)
        .set({ state: 'live', closedAt: null, errorMessage: null })
        .where(and(
          eq(deployments.id, dep.id),
          eq(deployments.state, 'closed'),
          like(deployments.errorMessage, 'ingress unreachable%')
        ))
        .returning({ id: deployments.id });
      if (updated.length > 0) {
        log.info('cross-check rehydrated wrongly-closed deployment', {
          deploymentId: dep.id,
          dseq: dep.dseq,
        });
      }
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 404) return;
      log.warn('rehydrate cross-check failed', {
        deploymentId: dep.id,
        dseq: dep.dseq,
        err: String(err),
      });
    }
  }));
}

// Per-deployment cooldown so a deployment we already tried to rebind doesn't
// get hammered every poll tick if the rebind alone doesn't cure the silence
// (e.g. the container is genuinely crashing). In-memory: a process restart
// gives every deployment a fresh window which is fine — the user will only
// pay one extra Akash tx in the worst case.
const AUTO_REBIND_COOLDOWN_MS = 10 * 60_000;
const lastAutoRebindAttempt = new Map<string, number>();

async function autoRebindStaleRunners(
  akashKey: string,
  deps: Array<Awaited<ReturnType<typeof latestDeployment>>>
): Promise<void> {
  const now = Date.now();
  const targets = deps.filter((d): d is NonNullable<typeof d> => {
    if (!d || !d.dseq) return false;
    if (!isRunnerStale(d.runnerSeenAt, d.liveAt, d.state)) return false;
    const last = lastAutoRebindAttempt.get(d.id);
    return !last || now - last >= AUTO_REBIND_COOLDOWN_MS;
  });

  if (targets.length === 0) return;

  await Promise.allSettled(
    targets.map(async (dep) => {
      lastAutoRebindAttempt.set(dep.id, now);
      try {
        const outcome = await rebuildAndUpdateSdl({
          akashKey,
          fnId: dep.functionId,
          dep,
          reason: 'auto-stale',
        });
        if (!outcome.ok) {
          log.warn('auto-rebind skipped', {
            deploymentId: dep.id,
            status: outcome.status,
            message: outcome.message,
          });
          return;
        }
        log.info('auto-rebind submitted', {
          deploymentId: dep.id,
          dseq: dep.dseq,
          runnerSeenAt: dep.runnerSeenAt?.toISOString(),
        });
      } catch (err) {
        log.warn('auto-rebind failed', {
          deploymentId: dep.id,
          dseq: dep.dseq,
          err: String(err),
        });
      }
    })
  );
}

async function markClosedOnChain(deploymentId: string, errorMessage: string): Promise<void> {
  await db
    .update(deployments)
    .set({ state: 'closed', closedAt: new Date(), errorMessage })
    .where(and(eq(deployments.id, deploymentId), notInArray(deployments.state, ['closed', 'failed'])));
  log.info('cross-check marked deployment closed', { deploymentId, errorMessage });
}

functionsRouter.post('/', zValidator('json', CreateBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const walletAddress = c.get('walletAddress');
  const body = c.req.valid('json');
  const subdomain = mintSubdomain(body.name);

  // Any env vars supplied at create-time need to land in function_variables
  // (encrypted, runner-visible) — not just function_versions.env_vars, which
  // is metadata the runner doesn't read. Validate + encrypt outside the
  // transaction so cipher errors / reserved-key errors don't lock rows.
  const envEntries = Object.entries(body.envVars ?? {});
  if (envEntries.length > MAX_VARIABLES_PER_FUNCTION) {
    throw new HTTPException(400, {
      message: `Cannot exceed ${MAX_VARIABLES_PER_FUNCTION} variables per function`,
    });
  }
  let totalPlaintext = 0;
  const encryptedEntries: Array<{
    key: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  }> = [];
  for (const [key, value] of envEntries) {
    const keyError = validateVariableKey(key);
    if (keyError) throw new HTTPException(400, { message: keyError });
    totalPlaintext += Buffer.byteLength(value, 'utf8');
    if (totalPlaintext > MAX_TOTAL_PLAINTEXT_BYTES) {
      throw new HTTPException(400, {
        message: `Total variables size would exceed ${MAX_TOTAL_PLAINTEXT_BYTES} bytes`,
      });
    }
    try {
      const enc = secrets.encrypt(value);
      encryptedEntries.push({ key, ...enc });
    } catch (err) {
      log.error('secrets.encrypt failed during create', { err: String(err) });
      throw new HTTPException(500, { message: 'Failed to encrypt variable' });
    }
  }

  const inserted = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
        walletAddress,
        name: body.name,
        subdomain,
        // Bump revision so the runner picks up the env on its first poll.
        ...(encryptedEntries.length > 0 ? { variablesRevision: 1 } : {}),
      })
      .returning();
    if (!fn) throw new HTTPException(500, { message: 'Failed to insert function' });

    await tx.insert(functionVersions).values({
      functionId: fn.id,
      preset: body.preset,
      prompt: body.prompt ?? null,
      ...encryptedSourceColumns(body.source),
      resources: body.resources,
      envVars: body.envVars ?? {},
    });

    if (encryptedEntries.length > 0) {
      const now = new Date();
      await tx.insert(functionVariables).values(
        encryptedEntries.map((e) => ({
          functionId: fn.id,
          key: e.key,
          ciphertext: e.ciphertext,
          iv: e.iv,
          authTag: e.authTag,
          keyVersion: e.keyVersion,
          createdAt: now,
          updatedAt: now,
        }))
      );
    }

    return fn;
  });

  if (encryptedEntries.length > 0) {
    log.info('function variables seeded on create', {
      fnId: inserted.id,
      keys: encryptedEntries.map((e) => e.key),
    });
  }

  return c.json(toRecord(inserted), 201);
});

functionsRouter.get('/:id', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);
  return c.json(toRecord(fn));
});

functionsRouter.put('/:id', zValidator('json', UpdateNameBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);
  const [updated] = await db
    .update(functions)
    .set({ name: c.req.valid('json').name, updatedAt: new Date() })
    .where(eq(functions.id, id))
    .returning();
  if (!updated) throw new HTTPException(500, { message: 'Update failed' });
  return c.json(toRecord(updated));
});

functionsRouter.put('/:id/code', zValidator('json', UpdateCodeBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);
  const body = c.req.valid('json');

  // Need an existing version to copy unset fields from.
  const [latest] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);

  const [version] = await db
    .insert(functionVersions)
    .values({
      functionId: id,
      preset: latest?.preset ?? 'rest',
      prompt: latest?.prompt ?? null,
      message: body.message ?? null,
      ...encryptedSourceColumns(body.source),
      resources: body.resources ?? latest?.resources ?? { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
      envVars: body.envVars ?? latest?.envVars ?? {},
    })
    .returning();
  if (!version) throw new HTTPException(500, { message: 'Insert failed' });
  return c.json(
    { id: version.id, createdAt: version.createdAt.toISOString(), message: version.message },
    201
  );
});

// GET /:id/versions — list every version of a function (most recent first).
// Returns lightweight summaries; use GET /:id/versions/:versionId for source.
functionsRouter.get('/:id/versions', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);

  const rows = await db
    .select({
      id: functionVersions.id,
      createdAt: functionVersions.createdAt,
      message: functionVersions.message,
      preset: functionVersions.preset,
      deploymentCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deployments}
        WHERE ${deployments.versionId} = ${functionVersions.id}
      )`,
    })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(100);

  const list: FunctionVersionSummary[] = rows.map((r, i) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    message: r.message,
    preset: r.preset as PresetId,
    isLatest: i === 0,
    deploymentCount: r.deploymentCount,
  }));

  return c.json(list);
});

// GET /:id/versions/:versionId — full detail for a single version (source + config).
functionsRouter.get('/:id/versions/:versionId', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  await getFn(walletAddress, id);

  const [v] = await db
    .select()
    .from(functionVersions)
    .where(and(eq(functionVersions.id, versionId), eq(functionVersions.functionId, id)))
    .limit(1);
  if (!v) throw new HTTPException(404, { message: 'Version not found' });

  const [latest] = await db
    .select({ id: functionVersions.id })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);

  const countRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(deployments)
    .where(eq(deployments.versionId, v.id));
  const count = countRows[0]?.count ?? 0;

  const detail: FunctionVersionDetail = {
    id: v.id,
    createdAt: v.createdAt.toISOString(),
    message: v.message,
    preset: v.preset as PresetId,
    isLatest: latest?.id === v.id,
    deploymentCount: count,
    source: readSource(v),
    resources: v.resources,
    envVars: v.envVars,
  };
  return c.json(detail);
});

// POST /:id/versions/:versionId/restore — copy an old version forward as a new
// version. Never destructive; the resulting version becomes the latest.
// Does NOT trigger a deploy on its own.
functionsRouter.post('/:id/versions/:versionId/restore', zValidator('json', RestoreBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  await getFn(walletAddress, id);
  const body = c.req.valid('json');

  const [target] = await db
    .select()
    .from(functionVersions)
    .where(and(eq(functionVersions.id, versionId), eq(functionVersions.functionId, id)))
    .limit(1);
  if (!target) throw new HTTPException(404, { message: 'Version not found' });

  const defaultMessage = `Restored from ${target.id.slice(0, 7)} @ ${target.createdAt.toISOString()}`;

  const [created] = await db
    .insert(functionVersions)
    .values({
      functionId: id,
      preset: target.preset,
      prompt: target.prompt,
      message: body.message ?? defaultMessage,
      ...encryptedSourceColumns(readSource(target)),
      resources: target.resources,
      envVars: target.envVars,
    })
    .returning();
  if (!created) throw new HTTPException(500, { message: 'Insert failed' });

  return c.json(
    { id: created.id, createdAt: created.createdAt.toISOString(), message: created.message },
    201
  );
});

// POST /:id/clone — create a new function from an existing one's latest version
// and fire its deploy pipeline. Used by "Redeploy" since 1 function = 1
// deployment; you can't reuse the original record once it's been deployed.
functionsRouter.post('/:id/clone', async (c) => {
  const ownerHash = c.get('ownerHash');
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const id = c.req.param('id');
  const source = await getFn(walletAddress, id);

  // Latest version provides source/resources/envVars/preset.
  const [latest] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);
  if (!latest) throw new HTTPException(400, { message: 'Source function has no code version' });

  // Insert function + version + pending deployment in one transaction.
  const { fn, version, dep } = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
        walletAddress,
        name: source.name,
        subdomain: mintSubdomain(source.name),
      })
      .returning();
    if (!fn) throw new HTTPException(500, { message: 'Failed to insert cloned function' });

    const [version] = await tx
      .insert(functionVersions)
      .values({
        functionId: fn.id,
        preset: latest.preset,
        prompt: latest.prompt,
        ...encryptedSourceColumns(readSource(latest)),
        resources: latest.resources,
        envVars: latest.envVars,
      })
      .returning();
    if (!version) throw new HTTPException(500, { message: 'Failed to insert cloned version' });

    const [dep] = await tx
      .insert(deployments)
      .values({
        functionId: fn.id,
        versionId: version.id,
        state: 'pending',
      })
      .returning();
    if (!dep) throw new HTTPException(500, { message: 'Failed to insert deployment' });

    return { fn, version, dep };
  });

  // Build SDL + fire pipeline (same shape as POST /:id/deploy). User-defined
  // env vars (including AKASHML_API_KEY) flow through /api/runner/env at boot,
  // not through the SDL — the SDL is visible to providers and we don't want
  // user secrets in it.
  const runnerToken = signRunner({ fnId: fn.id });
  const sdl = await buildSdl({
    functionId: fn.id,
    initialVersionId: version.id,
    runnerToken,
    resources: version.resources,
  });
  startDeployPipeline({ apiKey: akashKey, deploymentId: dep.id, sdl, serviceName: 'fn' });

  // Redeploy = replace, not duplicate. Close the source function's active
  // lease in the background so the user doesn't pay for both — important
  // when the redeploy was triggered to escape a misbehaving provider. We
  // fire-and-forget rather than awaiting so the API response isn't delayed
  // by the on-chain close; the new deployment is already in flight, so the
  // user has a working endpoint as soon as it goes live regardless of how
  // long the close takes. Failures here are logged but don't bubble up:
  // a lingering source lease is annoying but the clone itself succeeded.
  void closeAllActiveDeployments(id, akashKey)
    .then((count) => {
      if (count > 0) {
        log.info('closed source deployment(s) on redeploy', {
          sourceFunctionId: id,
          newFunctionId: fn.id,
          closed: count,
        });
      }
    })
    .catch((err) =>
      log.warn('close source deployment on redeploy failed', {
        sourceFunctionId: id,
        newFunctionId: fn.id,
        err: String(err),
      })
    );

  return c.json(
    {
      ...toRecord(fn),
      deploymentId: dep.id,
      latestDeploymentId: dep.id,
    },
    201
  );
});

// POST /:id/close-deployment — close the active Akash lease without
// tombstoning the function. Used by the migration flow (close 1.x pod →
// Save & Deploy boots a 2.x pod with hot-reload). The function record and
// version history stay; the user can redeploy whenever.
functionsRouter.post('/:id/close-deployment', async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);

  const closed = await closeAllActiveDeployments(fn.id, akashKey);
  if (closed === 0) {
    throw new HTTPException(409, { message: 'No active deployment to close' });
  }
  return c.body(null, 204);
});

// Encrypted user-defined env vars. Plaintext is only emitted on the
// runner-only /api/runner/env/:fnId route — the browser API is write-only.

const MAX_VARIABLES_PER_FUNCTION = 100;
const MAX_TOTAL_PLAINTEXT_BYTES = 256 * 1024;

const PutVariableBody = z.object({
  value: z
    .string()
    .min(1, 'value cannot be empty')
    .max(64 * 1024, 'value exceeds 64KB')
    .refine((s) => !s.includes('\0'), 'value contains a null byte'),
});

functionsRouter.get('/:id/variables', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);

  const rows = await db
    .select({
      key: functionVariables.key,
      updatedAt: functionVariables.updatedAt,
    })
    .from(functionVariables)
    .where(eq(functionVariables.functionId, id))
    .orderBy(functionVariables.key);

  const body: FunctionVariablesResponse = {
    variables: rows.map((r) => ({ key: r.key, updatedAt: r.updatedAt.toISOString() })),
    variablesRevision: fn.variablesRevision,
  };
  return c.json(body);
});

functionsRouter.put('/:id/variables/:key', zValidator('json', PutVariableBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const key = c.req.param('key');
  await getFn(walletAddress, id);

  const keyError = validateVariableKey(key);
  if (keyError) throw new HTTPException(400, { message: keyError });

  const { value } = c.req.valid('json');

  // Encrypt outside the transaction so cipher errors don't lock rows.
  let encrypted;
  try {
    encrypted = secrets.encrypt(value);
  } catch (err) {
    log.error('secrets.encrypt failed', { err: String(err) });
    throw new HTTPException(500, { message: 'Failed to encrypt variable' });
  }

  const updated = await db.transaction(async (tx) => {
    // Single aggregate query for both caps + presence check.
    const [stats] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(length(${functionVariables.ciphertext})), 0)::int`,
        hasKey: sql<boolean>`bool_or(${functionVariables.key} = ${key})`,
      })
      .from(functionVariables)
      .where(eq(functionVariables.functionId, id));

    const count = stats?.n ?? 0;
    const otherBytes = (stats?.bytes ?? 0) -
      (stats?.hasKey ? Buffer.byteLength(encrypted.ciphertext, 'utf8') : 0);
    if (!stats?.hasKey && count >= MAX_VARIABLES_PER_FUNCTION) {
      throw new HTTPException(400, {
        message: `Cannot exceed ${MAX_VARIABLES_PER_FUNCTION} variables per function`,
      });
    }
    if (otherBytes + Buffer.byteLength(value, 'utf8') > MAX_TOTAL_PLAINTEXT_BYTES) {
      throw new HTTPException(400, {
        message: `Total variables size would exceed ${MAX_TOTAL_PLAINTEXT_BYTES} bytes`,
      });
    }

    const now = new Date();
    const [row] = await tx
      .insert(functionVariables)
      .values({
        functionId: id,
        key,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [functionVariables.functionId, functionVariables.key],
        set: {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          updatedAt: now,
        },
      })
      .returning({ updatedAt: functionVariables.updatedAt });

    if (!row) throw new HTTPException(500, { message: 'Upsert returned no row' });

    const [bumped] = await tx
      .update(functions)
      .set({ variablesRevision: sql`${functions.variablesRevision} + 1` })
      .where(eq(functions.id, id))
      .returning({ revision: functions.variablesRevision });

    return { updatedAt: row.updatedAt, revision: bumped?.revision ?? 0 };
  });

  log.info('function variable upserted', { fnId: id, key, revision: updated.revision });

  const body: PutFunctionVariableResponse = {
    key,
    updatedAt: updated.updatedAt.toISOString(),
    variablesRevision: updated.revision,
  };
  return c.json(body);
});

functionsRouter.delete('/:id/variables/:key', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const key = c.req.param('key');
  await getFn(walletAddress, id);

  const deletedRevision = await db.transaction(async (tx) => {
    const result = await tx
      .delete(functionVariables)
      .where(and(eq(functionVariables.functionId, id), eq(functionVariables.key, key)))
      .returning({ key: functionVariables.key });

    if (result.length === 0) return null;

    const [bumped] = await tx
      .update(functions)
      .set({ variablesRevision: sql`${functions.variablesRevision} + 1` })
      .where(eq(functions.id, id))
      .returning({ revision: functions.variablesRevision });
    return bumped?.revision ?? 0;
  });

  if (deletedRevision === null) {
    throw new HTTPException(404, { message: 'Variable not found' });
  }
  log.info('function variable deleted', { fnId: id, key, revision: deletedRevision });
  // Returning the new revision lets the UI splice locally instead of refetching.
  c.status(200);
  return c.json({ key, variablesRevision: deletedRevision });
});

// Per-function protected-routes set. Each entry is a `"<METHOD> <path>"` string
// (e.g. `"POST /api/secret"`). The runner sidecar reads this list via the same
// /api/runner/current poll it already uses for version updates and rejects
// unauthenticated calls before they reach user code.
const ProtectedRoutesBody = z.object({
  protectedRoutes: z
    .array(z.string().min(3).max(2048))
    .max(200),
});

functionsRouter.get('/:id/protected-routes', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);
  const body: ProtectedRoutesResponse = { protectedRoutes: fn.protectedRoutes };
  return c.json(body);
});

functionsRouter.put(
  '/:id/protected-routes',
  zValidator('json', ProtectedRoutesBody),
  async (c) => {
    const walletAddress = c.get('walletAddress');
    const id = c.req.param('id');
    await getFn(walletAddress, id);
    const { protectedRoutes } = c.req.valid('json');
    // De-dupe + normalize whitespace so the runner can compare with a Set.
    const normalized = Array.from(
      new Set(
        protectedRoutes
          .map((s) => s.trim())
          .filter((s) => /^[A-Z]+ \//.test(s))
      )
    );
    const [updated] = await db
      .update(functions)
      .set({ protectedRoutes: normalized, updatedAt: new Date() })
      .where(eq(functions.id, id))
      .returning({ protectedRoutes: functions.protectedRoutes });
    if (!updated) throw new HTTPException(500, { message: 'Update failed' });
    const body: ProtectedRoutesResponse = { protectedRoutes: updated.protectedRoutes };
    return c.json(body);
  }
);

functionsRouter.delete('/:id', async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);

  // Best-effort: close any live deployments on Akash before tombstoning.
  await closeAllActiveDeployments(fn.id, akashKey);

  await db
    .update(functions)
    .set({ deletedAt: new Date(), status: 'closed' })
    .where(eq(functions.id, id));

  return c.body(null, 204);
});

// ─── helpers ───────────────────────────────────────────────────────────

async function getFn(walletAddress: string, id: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, id), eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });
  return fn;
}

// Closes every non-closed/non-failed deployment row for a function, and tries
// the matching close on Akash for any row that has a dseq. Returns the count
// of rows actually closed. Used by both the close-deployment and delete paths
// so we never leave an orphan lease alive (which would silently keep draining
// AKT after the user thought the function was torn down).
async function closeAllActiveDeployments(
  functionId: string,
  akashKey: string
): Promise<number> {
  const active = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.functionId, functionId),
        notInArray(deployments.state, ['closed', 'failed'])
      )
    );

  let closed = 0;
  for (const dep of active) {
    if (dep.dseq) {
      try {
        await consoleApi.closeDeployment(akashKey, dep.dseq);
      } catch (err) {
        log.warn('console-api closeDeployment failed; marking row closed anyway', {
          err: String(err),
          functionId,
          dseq: dep.dseq,
        });
      }
    }
    await db
      .update(deployments)
      .set({ state: 'closed', closedAt: new Date() })
      .where(eq(deployments.id, dep.id));
    closed += 1;
  }

  // A closed waiting service was pinning the cached key (key-cache.ts broadens
  // eviction to `state='waiting'`). Services have no teardown driver to evict
  // for them, so do it here once the function's deployments are all closed.
  // Wallet-wide and best-effort: it no-ops if another job/waiting row remains.
  if (closed > 0) {
    const [fn] = await db
      .select({ walletAddress: functions.walletAddress })
      .from(functions)
      .where(eq(functions.id, functionId))
      .limit(1);
    if (fn?.walletAddress) await evictWalletKeyIfIdle(fn.walletAddress);
  }

  return closed;
}

async function latestDeployment(functionId: string) {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.functionId, functionId))
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return row ?? null;
}

function mintSubdomain(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug || 'fn'}-prod-${suffix}`;
}

function toRecord(fn: typeof functions.$inferSelect): FunctionRecord {
  const isJob = fn.executionKind === 'job';
  return {
    id: fn.id,
    name: fn.name,
    kind: isJob ? 'python-job' : 'function',
    image: isJob ? env.PYTHON_RUNNER_IMAGE : env.RUNNER_IMAGE,
    status: stateToStatus(fn.status),
    createdAt: fn.createdAt.toISOString(),
    updatedAt: fn.updatedAt.toISOString(),
  };
}

function stateToStatus(state: string, errorMessage: string | null = null): FunctionRecord['status'] {
  switch (state) {
    case 'live':
      // A 'live' row with an errorMessage means the reconciler's ingress probe
      // is striking out (yellow degraded), or the runner reported a non-fatal
      // runtime error. The lease is still paid, so we don't want it offline.
      return errorMessage ? 'degraded' : 'online';
    case 'running':
      // Job lease is up and the user's script is executing. The job card pill
      // itself is computed from runOutcome+exitCode (D6); this generic status
      // just reflects "actively up".
      return 'online';
    case 'pending':
    case 'bidding':
    case 'leased':
      return 'pending';
    case 'waiting':
      // Wait-for-capacity: parked, retrying in the background. Distinct from
      // 'pending' — the dashboard surfaces its own amber "waiting" affordance
      // and poll cadence. This mapping is the sole notification surface.
      return 'waiting';
    case 'failed':
    case 'closed':
      return 'offline';
    default:
      // Unknown — treat as no deployment (orphan / draft).
      return 'idle';
  }
}
