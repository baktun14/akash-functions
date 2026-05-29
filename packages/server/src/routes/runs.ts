// /api/functions — Python GPU **runs** (job-functions).
//
// A "run" is exactly one `deployments` row with run_kind='job' (no separate
// runs table). Mounted at the same /api/functions prefix as functionsRouter;
// Hono's static-segment precedence resolves `/runs` vs `/:id` and
// `/:id/runs` vs `/:id` cleanly.
//
// Differences from the service deploy path:
//   - createAndRun makes the function execution_kind='job' (immutable, D3).
//   - the 1-active-deployment 409 guard is SKIPPED — concurrent runs are
//     allowed (D6).
//   - the pipeline runs in job mode (no URI poll; waits for first heartbeat).
//   - the user's Console key is cached encrypted for autonomous teardown (D1).

import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { DeploymentState, RunLogChunk, RunOutcome, RunRecord } from '@shared/types';
import { startDeployPipeline } from '../akash/pipeline';
import { buildSdl } from '../akash/sdl';
import { cacheWalletKey } from '../akash/key-cache';
import { cancelRunLease } from '../akash/teardown';
import { db } from '../db/client';
import { deployments, functionVariables, functionVersions, functions, runLogs } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { secrets } from '../lib/secrets';
import { encryptedSourceColumns } from '../lib/source';
import { signRunner } from '../lib/signing';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { validateVariableKey } from '@shared/reserved-vars';

export const runsRouter = new Hono<{ Variables: AuthVars }>();

runsRouter.use('*', requireAkashKey);

const MAX_VARIABLES = 50;
const MAX_TOTAL_PLAINTEXT_BYTES = 256 * 1024;
// Cold CUDA/PyTorch wheels need real disk — floor job storage well above the
// CPU service baseline so pip never ENOSPC.
const JOB_STORAGE_FLOOR_GI = 20;

const SourceSchema = z.record(z.string(), z.string());
const ResourceSchema = z.object({
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
  gpu: z
    .object({
      vendor: z.enum(['nvidia', 'amd']),
      model: z.string().min(1).max(40),
      units: z.number().int().positive().max(8).optional(),
    })
    .optional(),
});

const CreateAndRunBody = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().max(4000).optional(),
  source: SourceSchema,
  resources: ResourceSchema,
  envVars: z.record(z.string(), z.string()).optional(),
});

const CreateRunBody = z.object({
  versionId: z.string().uuid().optional(),
});

// ── createAndRun: function + version + first run, in one go ──
runsRouter.post('/runs', zValidator('json', CreateAndRunBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const body = c.req.valid('json');

  // Cache the Console key (encrypted) for autonomous teardown (D1).
  await cacheWalletKey(walletAddress, akashKey);

  const encryptedEntries = encryptEnvVars(body.envVars);
  const resources = withJobStorageFloor(body.resources);

  const created = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
        walletAddress,
        name: body.name,
        subdomain: mintSubdomain(body.name),
        executionKind: 'job', // immutable (D3)
        ...(encryptedEntries.length > 0 ? { variablesRevision: 1 } : {}),
      })
      .returning();
    if (!fn) throw new HTTPException(500, { message: 'Failed to insert function' });

    const [version] = await tx
      .insert(functionVersions)
      .values({
        functionId: fn.id,
        preset: 'python',
        prompt: body.prompt ?? null,
        ...encryptedSourceColumns(body.source),
        resources,
        envVars: body.envVars ?? {},
      })
      .returning();
    if (!version) throw new HTTPException(500, { message: 'Failed to insert version' });

    if (encryptedEntries.length > 0) {
      const now = new Date();
      await tx.insert(functionVariables).values(
        encryptedEntries.map((e) => ({ functionId: fn.id, ...e, createdAt: now, updatedAt: now }))
      );
    }

    const [dep] = await tx
      .insert(deployments)
      .values({
        functionId: fn.id,
        versionId: version.id,
        state: 'pending',
        runKind: 'job',
        maxDurationMs: env.JOB_MAX_DURATION_MS,
      })
      .returning();
    if (!dep) throw new HTTPException(500, { message: 'Failed to record run' });

    return { fn, version, dep };
  });

  await launchRun(created.fn.id, created.version.id, created.dep.id, resources, akashKey);
  return c.json(toRunRecord(created.dep), 201);
});

// ── createRun: a new run of an EXISTING job-function ──
runsRouter.post('/:id/runs', zValidator('json', CreateRunBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const fnId = c.req.param('id');
  const body = c.req.valid('json');

  const fn = await ownedJobFunction(fnId, walletAddress);
  await cacheWalletKey(walletAddress, akashKey);

  const version = body.versionId
    ? (
        await db
          .select()
          .from(functionVersions)
          .where(and(eq(functionVersions.id, body.versionId), eq(functionVersions.functionId, fnId)))
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(functionVersions)
          .where(eq(functionVersions.functionId, fnId))
          .orderBy(desc(functionVersions.createdAt))
          .limit(1)
      )[0];
  if (!version) throw new HTTPException(400, { message: 'No code version to run' });

  // NO 409 guard — concurrent runs are allowed (D6).
  const resources = withJobStorageFloor(version.resources);
  const [dep] = await db
    .insert(deployments)
    .values({
      functionId: fn.id,
      versionId: version.id,
      state: 'pending',
      runKind: 'job',
      maxDurationMs: env.JOB_MAX_DURATION_MS,
    })
    .returning();
  if (!dep) throw new HTTPException(500, { message: 'Failed to record run' });

  await launchRun(fn.id, version.id, dep.id, resources, akashKey);
  return c.json(toRunRecord(dep), 201);
});

// ── getRun ──
runsRouter.get('/:id/runs/:runId', async (c) => {
  const walletAddress = c.get('walletAddress');
  const fnId = c.req.param('id');
  const runId = c.req.param('runId');
  await ownedJobFunction(fnId, walletAddress);

  const [dep] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, runId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Run not found' });
  return c.json(toRunRecord(dep));
});

// ── listRuns ──
runsRouter.get('/:id/runs', async (c) => {
  const walletAddress = c.get('walletAddress');
  const fnId = c.req.param('id');
  await ownedJobFunction(fnId, walletAddress);

  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.functionId, fnId))
    .orderBy(desc(deployments.createdAt));
  return c.json(rows.map(toRunRecord));
});

// ── cancelRun ──
runsRouter.post('/:id/runs/:runId/cancel', async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const fnId = c.req.param('id');
  const runId = c.req.param('runId');
  await ownedJobFunction(fnId, walletAddress);

  // Scope-check the run belongs to this function before closing its lease.
  const [dep] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.id, runId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Run not found' });

  const ok = await cancelRunLease(runId, akashKey);
  if (!ok) throw new HTTPException(404, { message: 'Run not found' });
  return c.body(null, 204);
});

// ── streamRunLogs (SSE) ──
//
// Backfill persisted chunks by seq, then poll-tail every ~750ms. Emits a final
// `end` once the run is terminal AND all logs are flushed. `?afterSeq` lets the
// client resume after a reconnect. Mirrors the agentChatStream SSE shape.
const TAIL_POLL_MS = 750;
const KEEPALIVE_EVERY = 8; // ~6s of silence → keepalive comment

runsRouter.get('/:id/runs/:runId/logs', async (c) => {
  const walletAddress = c.get('walletAddress');
  const fnId = c.req.param('id');
  const runId = c.req.param('runId');
  await ownedJobFunction(fnId, walletAddress);

  const [dep] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.id, runId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Run not found' });

  const afterSeqParam = Number(c.req.query('afterSeq'));
  let lastSeq = Number.isFinite(afterSeqParam) && afterSeqParam >= 0 ? afterSeqParam : -1;

  return streamSSE(c, async (sse) => {
    const send = (chunk: RunLogChunk) => sse.writeSSE({ data: JSON.stringify(chunk) });
    let lastState: DeploymentState | null = null;
    let lastOutcome: RunOutcome | null = null;
    let idleTicks = 0;

    while (!c.req.raw.signal.aborted) {
      // Drain any new log rows.
      const rows = await db
        .select()
        .from(runLogs)
        .where(and(eq(runLogs.deploymentId, runId), gt(runLogs.seq, lastSeq)))
        .orderBy(asc(runLogs.seq))
        .limit(2000);
      for (const row of rows) {
        await send({
          type: 'log',
          seq: row.seq,
          stream: row.stream === 'stderr' ? 'stderr' : 'stdout',
          text: row.chunk,
          ts: row.ts.toISOString(),
        });
        lastSeq = row.seq;
      }

      // Emit a state frame whenever lease state / outcome changes.
      const [run] = await db
        .select({
          state: deployments.state,
          runOutcome: deployments.runOutcome,
          exitCode: deployments.exitCode,
        })
        .from(deployments)
        .where(eq(deployments.id, runId))
        .limit(1);
      if (run) {
        const state = run.state as DeploymentState;
        const outcome = (run.runOutcome as RunOutcome | null) ?? null;
        if (state !== lastState || outcome !== lastOutcome) {
          lastState = state;
          lastOutcome = outcome;
          await send({
            type: 'state',
            state,
            runOutcome: outcome ?? undefined,
            exitCode: run.exitCode ?? undefined,
          });
        }
        // Terminal AND caught up (no rows this tick) → end the stream.
        const terminal = outcome != null || state === 'closed' || state === 'failed';
        if (terminal && rows.length === 0) {
          await send({ type: 'end' });
          return;
        }
      }

      if (rows.length === 0) {
        idleTicks += 1;
        if (idleTicks % KEEPALIVE_EVERY === 0) {
          await sse.writeSSE({ data: '', event: 'keepalive' });
        }
        await sleep(TAIL_POLL_MS);
      } else {
        idleTicks = 0;
      }
    }
  });
});

// ── helpers ──

async function ownedJobFunction(fnId: string, walletAddress: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });
  if (fn.executionKind !== 'job') {
    throw new HTTPException(400, { message: 'Function is not a Python job' });
  }
  return fn;
}

// Build the job SDL (needs the deployment id for DEPLOYMENT_ID) and fire the
// pipeline in job mode. On SDL-build failure, fail the row rather than leaving
// it stuck pending.
async function launchRun(
  fnId: string,
  versionId: string,
  deploymentId: string,
  resources: z.infer<typeof ResourceSchema>,
  akashKey: string
): Promise<void> {
  try {
    const runnerToken = signRunner({ fnId });
    const sdl = await buildSdl({
      functionId: fnId,
      initialVersionId: versionId,
      runnerToken,
      resources,
      executionKind: 'job',
      deploymentId,
    });
    startDeployPipeline({
      apiKey: akashKey,
      deploymentId,
      sdl,
      serviceName: 'fn',
      runKind: 'job',
      maxDurationMs: env.JOB_MAX_DURATION_MS,
    });
  } catch (err) {
    log.error('failed to launch run', { fnId, deploymentId, err: String(err) });
    await db
      .update(deployments)
      .set({ state: 'failed', runOutcome: 'failed', errorMessage: String(err) })
      .where(eq(deployments.id, deploymentId));
  }
}

function encryptEnvVars(
  envVars: Record<string, string> | undefined
): Array<{ key: string; ciphertext: string; iv: string; authTag: string; keyVersion: number }> {
  const entries = Object.entries(envVars ?? {});
  if (entries.length > MAX_VARIABLES) {
    throw new HTTPException(400, { message: `Cannot exceed ${MAX_VARIABLES} variables per function` });
  }
  let total = 0;
  const out: Array<{ key: string; ciphertext: string; iv: string; authTag: string; keyVersion: number }> = [];
  for (const [key, value] of entries) {
    const keyError = validateVariableKey(key);
    if (keyError) throw new HTTPException(400, { message: keyError });
    total += Buffer.byteLength(value, 'utf8');
    if (total > MAX_TOTAL_PLAINTEXT_BYTES) {
      throw new HTTPException(400, { message: `Total variables size exceeds ${MAX_TOTAL_PLAINTEXT_BYTES} bytes` });
    }
    out.push({ key, ...secrets.encrypt(value) });
  }
  return out;
}

// Floor a job's storage so cold CUDA wheels fit. Only bumps; never shrinks.
function withJobStorageFloor<T extends { storage: string }>(resources: T): T {
  const gi = parseGi(resources.storage);
  if (gi != null && gi >= JOB_STORAGE_FLOOR_GI) return resources;
  return { ...resources, storage: `${JOB_STORAGE_FLOOR_GI}Gi` };
}

function parseGi(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*Gi?B?$/i.exec(s.trim());
  if (m && m[1]) return Number(m[1]);
  // Mi → Gi
  const mm = /^(\d+(?:\.\d+)?)\s*Mi?B?$/i.exec(s.trim());
  if (mm && mm[1]) return Number(mm[1]) / 1024;
  return null;
}

function mintSubdomain(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug || 'job'}-run-${suffix}`;
}

function toRunRecord(dep: typeof deployments.$inferSelect): RunRecord {
  return {
    runId: dep.id,
    functionId: dep.functionId,
    versionId: dep.versionId,
    state: dep.state as DeploymentState,
    runOutcome: (dep.runOutcome as RunOutcome | null) ?? undefined,
    exitCode: dep.exitCode ?? undefined,
    provider: dep.provider ?? undefined,
    dseq: dep.dseq ?? undefined,
    startedAt: dep.startedAt?.toISOString(),
    finishedAt: dep.finishedAt?.toISOString(),
    maxDurationMs: dep.maxDurationMs ?? undefined,
    errorMessage: dep.errorMessage ?? undefined,
    createdAt: dep.createdAt.toISOString(),
    closedAt: dep.closedAt?.toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
