// Wait-for-capacity driver — the heart of delayed start.
//
// A deploy that opts into wait-for-capacity and gets no bid/GPU enters the
// durable `waiting` state (no on-chain deployment → zero cost) instead of
// failing. This module owns that state: the two transition seams call
// `enterWaitingOrFail` to park (or fail) a row, and the reconciler calls
// `driveWaitingRows` each tick to retry parked rows until a lease lands, the
// user cancels, or the wait cap elapses.
//
// Why reconciler-driven (not an in-process sleep loop): the `waiting` row IS the
// durable queue. Nothing is held in memory, so a server restart loses no
// waiters. The cached wallet key (key-cache.ts) lets the keyless reconciler act
// on Akash for retries, exactly as job teardown does.

import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { ResourceRequest } from '@shared/types';
import { db } from '../db/client';
import { deployments, type DeploymentRow, functionVersions } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { signRunner } from '../lib/signing';
import { getAvailableGpuModels, pickNextGpu } from './gpu-inventory';
import { evictWalletKeyIfIdle, getWalletKey, walletForDeployment } from './key-cache';
import { closeDseqBestEffort, startDeployPipeline } from './pipeline';
import { buildSdl } from './sdl';
import {
  clampMaxWaitMs,
  isWaitCapExceeded,
  shouldBurstNow,
  type WaitPolicyConfig,
} from './wait-policy';
// runs.ts ↔ waiting-driver is a function-level circular import (Seam A in
// runs.ts calls enterWaitingOrFail; the driver re-invokes runGpuMultiGroup). Both
// are resolved at call time, never at module-eval time, so ESM handles it.
import { runGpuMultiGroup, withJobStorageFloor } from '../routes/runs';

const TERMINAL_STATES = ['closed', 'failed'];

// Build the policy thresholds from env. Shared by the driver, the reconciler's
// burst supervisor, and the route clamps so there's one source of truth.
export function waitPolicyConfig(): WaitPolicyConfig {
  return {
    defaultMaxWaitMs: env.WAIT_FOR_CAPACITY_DEFAULT_MAX_WAIT_MS,
    maxWaitMs: env.WAIT_FOR_CAPACITY_MAX_WAIT_MS,
    minWaitMs: env.WAIT_FOR_CAPACITY_MIN_WAIT_MS,
    burstTimeoutMs: env.WAIT_FOR_CAPACITY_BURST_TIMEOUT_MS,
  };
}

// Runs default wait-for-capacity ON, but with a shorter default budget than
// deploys (ephemeral jobs shouldn't park for a day). Only the default differs —
// the [min, max] clamp and burst timeout are shared with deploys.
export function runWaitPolicyConfig(): WaitPolicyConfig {
  return { ...waitPolicyConfig(), defaultMaxWaitMs: env.RUN_WAIT_FOR_CAPACITY_DEFAULT_MAX_WAIT_MS };
}

// Called from both transition seams when a deploy got no bid/GPU.
//   - !waitForCapacity → fail exactly as today (preserves fail-fast).
//   - else → park the row in `waiting` (guarded against a racing cancel/complete
//     which must win). dseq is already closed by the caller, so we null it here
//     to keep cross-check / cancel from chasing a dead dseq. waitingSince is set
//     ONCE (COALESCE) so it survives retry bursts and anchors both cap + FIFO.
export async function enterWaitingOrFail(args: {
  deploymentId: string;
  waitForCapacity: boolean;
  failMessage: string;
}): Promise<void> {
  const { deploymentId, waitForCapacity, failMessage } = args;

  if (!waitForCapacity) {
    await db
      .update(deployments)
      .set({ state: 'failed', errorMessage: failMessage })
      .where(and(eq(deployments.id, deploymentId), notInArray(deployments.state, TERMINAL_STATES)));
    return;
  }

  await db
    .update(deployments)
    .set({
      state: 'waiting',
      errorMessage: 'Waiting for capacity…',
      waitingSince: sql`COALESCE(${deployments.waitingSince}, now())`,
      burstStartedAt: null,
      dseq: null,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        notInArray(deployments.state, TERMINAL_STATES),
        isNull(deployments.runOutcome)
      )
    );
}

// Reconciler tick entry point. Process the oldest waiters first (FIFO fairness)
// and fire at most MAX_BURSTS_PER_TICK bursts so a freed slot doesn't trigger a
// thundering herd of create/close cycles. Rows skipped for backoff / gate /
// missing key do NOT consume the budget — only an actual burst does.
export async function driveWaitingRows(): Promise<void> {
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.state, 'waiting'))
    .orderBy(asc(deployments.waitingSince));

  const cap = env.WAIT_FOR_CAPACITY_MAX_BURSTS_PER_TICK;
  let fired = 0;
  for (const row of rows) {
    if (fired >= cap) break;
    try {
      if (await driveOne(row)) fired++;
    } catch (err) {
      log.error('waiting-driver: driveOne failed', { deploymentId: row.id, err: String(err) });
    }
  }
}

// Drive one waiting row. Returns true iff it fired a burst (consumes the
// per-tick budget). Cap-fail, backoff skip, gate skip, and missing key all
// return false.
async function driveOne(row: DeploymentRow): Promise<boolean> {
  const now = new Date();
  const cfg = waitPolicyConfig();
  const isGpu = !!row.gpuModel;
  const isJob = row.runKind === 'job';
  const isGpuJob = isJob && isGpu;

  // 1. Cap — terminal fail once the wait window elapses. Needs no key.
  if (isWaitCapExceeded({ waitingSince: row.waitingSince, createdAt: row.createdAt, maxWaitMs: row.maxWaitMs, now }, cfg)) {
    const cap = clampMaxWaitMs(row.maxWaitMs, cfg);
    await failWaitingRow(
      row.id,
      `Delayed start timed out — no capacity became available within ${Math.round(cap / 3.6e6)}h.`
    );
    const wallet = await walletForDeployment(row.id);
    if (wallet) await evictWalletKeyIfIdle(wallet);
    return false;
  }

  // 2. Backoff — un-gated paths (CPU jobs + services) have no cheap capacity
  //    pre-check, so they back off between bursts. GPU jobs are throttled by the
  //    inventory gate (step 4) instead.
  if (!isGpuJob) {
    const anchor = row.waitingSince ?? row.createdAt;
    const waitedMs = now.getTime() - anchor.getTime();
    const sinceLastBurstMs = row.burstStartedAt ? now.getTime() - row.burstStartedAt.getTime() : null;
    if (!shouldBurstNow({ waitedMs, sinceLastBurstMs })) return false;
  }

  // 3. Key — null self-heals on the user's next authed request (which re-caches).
  const wallet = await walletForDeployment(row.id);
  if (!wallet) return false;
  const key = await getWalletKey(wallet);
  if (!key) return false;

  // 4. GPU gate — stay waiting unless some GPU acceptable to the fallback order
  //    has free capacity (the "tie into fallback order" requirement). Inventory
  //    is the 5-min cache; a load error just keeps the row waiting.
  if (isGpuJob) {
    let models;
    try {
      models = await getAvailableGpuModels(key);
    } catch (err) {
      log.warn('waiting-driver: GPU inventory load failed; staying waiting', { deploymentId: row.id, err: String(err) });
      return false;
    }
    if (!pickNextGpu(models, new Set())) return false;
  }

  // 5. CAS claim waiting → bidding; stamp the per-burst anchor. Only one tick
  //    wins; the burst then sits in `bidding`, which the `state='waiting'`
  //    selector structurally skips on later ticks.
  const claimed = await db
    .update(deployments)
    .set({ state: 'bidding', burstStartedAt: now })
    .where(and(eq(deployments.id, row.id), eq(deployments.state, 'waiting')))
    .returning({ id: deployments.id });
  if (claimed.length === 0) return false;

  // 6. Fire one burst (fire-and-forget). A no-bid burst re-enters
  //    enterWaitingOrFail → back to `waiting` (waitingSince preserved). A thrown
  //    burst re-parks rather than failing — the cap bounds the retry loop.
  void fireBurst(row, key).catch(async (err) => {
    log.error('waiting-driver: burst crashed; re-parking', { deploymentId: row.id, err: String(err) });
    await enterWaitingOrFail({ deploymentId: row.id, waitForCapacity: true, failMessage: String(err) });
  });
  return true;
}

// Build the right SDL for the row's kind and fire exactly one deploy burst.
async function fireBurst(row: DeploymentRow, key: string): Promise<void> {
  const [version] = await db
    .select({ resources: functionVersions.resources })
    .from(functionVersions)
    .where(eq(functionVersions.id, row.versionId))
    .limit(1);
  if (!version) {
    await failWaitingRow(row.id, 'internal: version missing for waiting row');
    return;
  }
  const isGpu = !!row.gpuModel;
  const isJob = row.runKind === 'job';

  // GPU job → fan out across all available models in one multi-group deployment,
  // same as the initial launch. It self-degrades to the sequential single-attempt
  // path when <2 models have capacity, and re-enters enterWaitingOrFail on
  // exhaustion. (Each burst is still one bounded ~36s poll, well under the burst
  // supervisor timeout.)
  if (isJob && isGpu) {
    await runGpuMultiGroup({
      fnId: row.functionId,
      versionId: row.versionId,
      deploymentId: row.id,
      resources: withJobStorageFloor(version.resources as ResourceRequest),
      akashKey: key,
      waitForCapacity: true,
    });
    return;
  }

  const runnerToken = signRunner({ fnId: row.functionId });
  if (isJob) {
    const resources = withJobStorageFloor(version.resources as ResourceRequest);
    const sdl = await buildSdl({
      functionId: row.functionId,
      initialVersionId: row.versionId,
      runnerToken,
      resources,
      executionKind: 'job',
      deploymentId: row.id,
    });
    startDeployPipeline({
      apiKey: key,
      deploymentId: row.id,
      sdl,
      serviceName: 'fn',
      runKind: 'job',
      maxDurationMs: row.maxDurationMs ?? env.JOB_MAX_DURATION_MS,
      waitForCapacity: true,
    });
    return;
  }

  // Service.
  const sdl = await buildSdl({
    functionId: row.functionId,
    initialVersionId: row.versionId,
    runnerToken,
    resources: version.resources as ResourceRequest,
  });
  startDeployPipeline({ apiKey: key, deploymentId: row.id, sdl, serviceName: 'fn', waitForCapacity: true });
}

// Burst supervisor (called from the reconciler watchdogs). A wait-for-capacity
// row sitting in pending/bidding/leased past the burst-supervisor timeout has a
// crashed or hung burst — its in-process driver is gone. Close any dangling
// on-chain deployment, then reclaim it to `waiting` (so the wait survives a
// server restart mid-burst) unless the wait cap has elapsed, in which case fail.
//
// Both writes re-assert the OBSERVED state (`eq(state, row.state)`) so we never
// clobber a burst that advanced to running/live between the reconciler's SELECT
// and this UPDATE.
export async function superviseStuckBurst(row: DeploymentRow): Promise<void> {
  const cfg = waitPolicyConfig();
  const now = new Date();
  const wallet = await walletForDeployment(row.id);
  const key = wallet ? await getWalletKey(wallet) : null;
  // Reclaim escrow from the hung burst's deployment (best-effort; needs the key).
  if (key && row.dseq) await closeDseqBestEffort(key, row.dseq);

  if (isWaitCapExceeded({ waitingSince: row.waitingSince, createdAt: row.createdAt, maxWaitMs: row.maxWaitMs, now }, cfg)) {
    await db
      .update(deployments)
      .set({ state: 'failed', errorMessage: 'Delayed start timed out — no capacity became available in time.', dseq: null })
      .where(and(eq(deployments.id, row.id), eq(deployments.state, row.state)));
    if (wallet) await evictWalletKeyIfIdle(wallet);
    log.info('waiting-driver: stalled burst past cap → failed', { deploymentId: row.id, fromState: row.state });
    return;
  }

  await db
    .update(deployments)
    .set({
      state: 'waiting',
      errorMessage: 'Waiting for capacity…',
      waitingSince: sql`COALESCE(${deployments.waitingSince}, now())`,
      burstStartedAt: null,
      dseq: null,
    })
    .where(and(eq(deployments.id, row.id), eq(deployments.state, row.state), isNull(deployments.runOutcome)));
  log.info('waiting-driver: reclaimed stalled burst to waiting', { deploymentId: row.id, fromState: row.state });
}

// Terminal-fail a row, but only if it's still `waiting` (a racing claim/cancel
// wins). Deploy-phase failure carries no run outcome — matches failRun, so the
// UI shows "Failed" (not "Failed · Exit N").
async function failWaitingRow(deploymentId: string, message: string): Promise<void> {
  await db
    .update(deployments)
    .set({ state: 'failed', errorMessage: message })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.state, 'waiting')));
  log.info('waiting-driver: wait window elapsed', { deploymentId, message });
}
