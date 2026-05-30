// Background reconciler — runs every 60s to keep deployment rows honest.
//
// Two sweeps per pass, both DB-only (no Akash API; the user's API key is not
// available outside an authed request):
//
// 1. Reachability of state='live' rows. We HTTP GET the first ingress URI
//    with a 5s timeout. Any HTTP response counts as reachable; connection
//    refused / DNS / timeout / 5xx counts as a strike. After 3 consecutive
//    strikes the row is stamped with an errorMessage so the dashboard
//    surfaces it as 'degraded' (yellow) — but the row stays state='live'.
//    Probes never close a row: this server's own outbound network blips
//    (DNS, NAT, brief Wi-Fi drop, sleep/wake) used to permanently nuke
//    deployments whose Akash lease was still active on-chain. The on-chain
//    cross-check at GET /api/functions is the only authoritative closer.
//    If the ingress recovers (probe succeeds), we clear the warning so the
//    function flips back to 'online'.
//
//    The probe is a single signal and an unreliable one — cross-provider
//    outbound HTTP from this server to a random `*.ingress.<provider>` host
//    can fail for reasons that say nothing about the user's deployment
//    (peering, transient TLS, slow first response). So we cross-check
//    against `runnerSeenAt`: if the runner has polled `/api/runner/current`
//    within RUNNER_FRESH_MS, we skip the stamp and heal any existing
//    'ingress unreachable' warning. The runner is the better signal — it
//    runs inside the deployment and only stops polling if the lease is
//    actually gone.
//
// 2. Stuck deploys. The pipeline (pipeline.ts) is fire-and-forget; if the
//    server restarts mid-run the row sits forever in pending/bidding/leased.
//    Anything older than STUCK_DEPLOY_TIMEOUT_MS in those states gets failed.
//
// Failure counters live in-memory; a process restart gives every row a fresh
// 3-probe grace window which is fine — the alternative would mean schema work
// for very little gain at this scale.
//
// Akash on-chain state is reconciled separately at GET /api/functions (where
// we have the user's apiKey). See routes/functions.ts.

import { and, eq, like, lt, notInArray, or } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments, type DeploymentRow } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { recordProviderFailure, recordProviderSuccess } from './provider-health';
import { requestTeardown } from './teardown';
import { driveWaitingRows, superviseStuckBurst, waitPolicyConfig } from './waiting-driver';
import { isBurstStale } from './wait-policy';

// Reserved path the runner answers directly (bypasses USER_PORT). Probing it
// through the provider ingress verifies the provider can route arbitrary
// non-root paths — catches providers whose ingress serves `/` but mis-routes
// everything else, which used to flow through as healthy because the old
// probe accepted any 2xx-4xx on `/`.
export const RUNNER_HEALTH_PATH = '/_akash_runner/health';

const TICK_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const FAILURES_BEFORE_CLOSE = 3;
const STUCK_DEPLOY_TIMEOUT_MS = 10 * 60_000;
// Runner polls /current every 10s by default and the API stamps runnerSeenAt
// on every successful poll. 90s = roughly 9 poll windows — long enough that a
// brief blip doesn't flip the gate, short enough that a lease that's actually
// gone (runner stopped) crosses the threshold within ~2 reconciler ticks.
// Exported so the on-demand /ingress-reachable probe in routes/deploy.ts can
// apply the same heartbeat-trust rule.
export const RUNNER_FRESH_MS = 90_000;

const failureCounts = new Map<string, number>();

let timer: ReturnType<typeof setInterval> | null = null;

export function startReconciler(): void {
  if (timer) return;
  void reconcileOnce().catch((err) => log.error('reconciler tick crashed', { err: String(err) }));
  timer = setInterval(() => {
    void reconcileOnce().catch((err) => log.error('reconciler tick crashed', { err: String(err) }));
  }, TICK_MS);
  log.info('reconciler started', { tickMs: TICK_MS });
}

export function stopReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function reconcileOnce(): Promise<void> {
  const rows = await db
    .select()
    .from(deployments)
    .where(notInArray(deployments.state, ['closed', 'failed']));

  await Promise.allSettled(rows.map((row) => reconcileRow(row)));

  // Wait-for-capacity: retry parked `waiting` rows (oldest-first, capped bursts).
  await driveWaitingRows();
}

async function reconcileRow(row: DeploymentRow): Promise<void> {
  // `waiting` rows are owned by driveWaitingRows (above) — no watchdog touches
  // them, so the wait cap is the only thing that ends a wait.
  if (row.state === 'waiting') return;
  // Jobs are port-less run-to-completion pods. They must NEVER hit the HTTP
  // reachability probe (there's no ingress to probe — that would HTTP-probe a
  // port-less pod to death) and they have their own watchdog (D1).
  if (row.runKind === 'job') {
    await reconcileJobRow(row);
    return;
  }
  if (row.state === 'live') {
    await checkLiveReachability(row);
    return;
  }
  if (row.state === 'pending' || row.state === 'bidding' || row.state === 'leased') {
    // Wait-for-capacity rows age on the per-burst anchor (burstStartedAt),
    // falling back to createdAt for a never-parked first attempt — NOT the
    // createdAt stuck-deploy timeout, which a long waiter's old createdAt would
    // trip the instant a retry burst flips it to bidding. A burst past the
    // supervisor timeout is reclaimed to `waiting` (or cap-failed), not failed.
    if (row.waitForCapacity) {
      if (isBurstStale({ burstStartedAt: row.burstStartedAt ?? row.createdAt, now: new Date() }, waitPolicyConfig())) {
        await superviseStuckBurst(row);
      }
      return;
    }
    const ageMs = Date.now() - row.createdAt.getTime();
    if (ageMs > STUCK_DEPLOY_TIMEOUT_MS) {
      await failStuckDeploy(row, ageMs);
    }
  }
}

// Job watchdog (D1). Closes zombie leases autonomously using the cached key —
// upgraded from the old detect-only behavior. Handles:
//   - orphan sweep: a terminal run (run_outcome set) whose lease isn't closed
//     yet (a /complete landed but teardown hasn't finished) → (re)request it.
//   - overrun: a running job past its max-duration backstop → fail + teardown.
//   - runner silence: a running job whose heartbeat went stale → presume dead,
//     fail + teardown.
//   - boot timeout: a pre-heartbeat job (pending/bidding/leased) older than the
//     generous JOB_BOOT_TIMEOUT_MS → fail + teardown.
async function reconcileJobRow(row: DeploymentRow): Promise<void> {
  const now = Date.now();

  // `waiting` rows are owned by driveWaitingRows; the boot-timeout below must
  // never see them (and a hung retry burst is handled in the pending/bidding
  // branch via the burst supervisor).
  if (row.state === 'waiting') return;

  // Orphan: the run finished (outcome recorded) but the lease is still open and
  // teardown hasn't completed. Nudge the teardown driver again.
  if (row.runOutcome && row.state !== 'closed' && row.teardownState !== 'done') {
    await requestTeardown(row.id);
    return;
  }

  if (row.state === 'running') {
    // Overrun backstop.
    const maxMs = row.maxDurationMs ?? env.JOB_MAX_DURATION_MS;
    const startedMs = (row.startedAt ?? row.createdAt).getTime();
    if (now - startedMs > maxMs) {
      await failJob(row, `run exceeded max duration (${Math.round(maxMs / 1000)}s)`);
      return;
    }
    // Runner silence — the pod went dark mid-run.
    if (row.runnerSeenAt && now - row.runnerSeenAt.getTime() > env.JOB_RUNNER_SILENCE_MS) {
      await failJob(row, 'runner went silent during run');
      return;
    }
    return;
  }

  if (row.state === 'pending' || row.state === 'bidding' || row.state === 'leased') {
    // Wait-for-capacity rows are supervised on the per-burst anchor and reclaimed
    // to `waiting` (not failed) — see reconcileRow for the rationale.
    if (row.waitForCapacity) {
      if (isBurstStale({ burstStartedAt: row.burstStartedAt ?? row.createdAt, now: new Date() }, waitPolicyConfig())) {
        await superviseStuckBurst(row);
      }
      return;
    }
    // Pre-heartbeat boot grace — cold CUDA pull + pip is slow, so jobs get a
    // much longer leash than the service stuck-deploy timeout.
    const ageMs = now - row.createdAt.getTime();
    if (ageMs > env.JOB_BOOT_TIMEOUT_MS) {
      await failJob(row, 'job did not start within boot timeout');
    }
  }
}

// Mark a job failed (run outcome) and request lease teardown. Idempotent via
// the state re-assert.
async function failJob(row: DeploymentRow, reason: string): Promise<void> {
  await db
    .update(deployments)
    .set({
      runOutcome: row.runOutcome ?? 'failed',
      errorMessage: row.errorMessage ?? reason,
      finishedAt: row.finishedAt ?? new Date(),
      teardownState: row.teardownState ?? 'requested',
    })
    .where(and(eq(deployments.id, row.id), eq(deployments.state, row.state)));
  log.warn('reconciler failing job', { deploymentId: row.id, reason, fromState: row.state });
  await requestTeardown(row.id);
}

async function checkLiveReachability(row: DeploymentRow): Promise<void> {
  const url = row.uris?.[0];
  if (!url) {
    // 'live' without a URI shouldn't happen — pipeline only sets live once
    // uris are populated. If it does, leave the row alone; nothing to probe.
    return;
  }

  // Probe the runner's reserved health path (not `/`). A 200 here proves the
  // provider's ingress can route arbitrary paths through to the runner; just
  // hitting `/` would have given a misleading green when user code happened
  // to serve the root while the provider's path-routing was broken.
  const reachable = await probe(toFetchUrl(url));
  if (reachable) {
    const hadFailures = failureCounts.delete(row.id);
    if (hadFailures || isProbeErrorMessage(row.errorMessage)) {
      await clearIngressErrorMessage(row.id);
    }
    if (row.provider) {
      // Fire-and-forget: don't let a transient DB blip block reconciliation.
      void recordProviderSuccess(row.provider).catch((err) =>
        log.error('recordProviderSuccess failed', { provider: row.provider, err: String(err) })
      );
    }
    return;
  }

  const runnerFresh = isRunnerFresh(row.runnerSeenAt);

  // If the runner became fresh after a prior runner-stale 'ingress unreachable'
  // stamp, drop that stamp — its premise (lease may be gone) no longer holds.
  // We do NOT touch the runner-fresh 'function routes unreachable' stamp here;
  // that one only clears on a successful probe above.
  if (runnerFresh && row.errorMessage?.startsWith('ingress unreachable')) {
    await clearIngressErrorMessage(row.id);
    log.info('cleared stale ingress-unreachable stamp: runner still reporting', {
      deploymentId: row.id,
      url,
      runnerSeenAt: row.runnerSeenAt,
    });
  }

  const next = (failureCounts.get(row.id) ?? 0) + 1;
  failureCounts.set(row.id, next);

  // Two strike thresholds, chosen by how confident we are about who's at fault:
  //   - runner fresh + probe fail = inbound path between us and the (provably
  //     alive) runner is broken. Highest-confidence provider-blame signal we
  //     have; act on it after a single strike so the dashboard surfaces the
  //     issue within one tick instead of three.
  //   - runner stale + probe fail = could be the lease, our outbound, or the
  //     provider. Keep the 3-strike threshold to absorb transient blips.
  const threshold = runnerFresh ? 1 : FAILURES_BEFORE_CLOSE;
  if (next < threshold) {
    log.warn('ingress probe failed', { deploymentId: row.id, url, strike: next, runnerFresh });
    return;
  }

  // Threshold reached. Attribute to the provider regardless of runner
  // freshness — the smoke probe is specific (exact path + strict 200), so the
  // failure pattern is unambiguous. When the runner heartbeat is fresh, the
  // 1-strike threshold above means we react within a single reconciler tick
  // (gcnlab.fyi pattern observed in testing: TCP open, request sent, response
  // never returns). When stale, 3 strikes give us a chance to absorb our own
  // outbound blips before placing a 24h cooldown.
  if (row.provider) {
    void recordProviderFailure(
      row.provider,
      runnerFresh
        ? 'smoke probe failed; runner heartbeat fresh'
        : 'smoke probe failed; runner heartbeat stale'
    ).catch((err) =>
      log.error('recordProviderFailure failed', { provider: row.provider, err: String(err) })
    );
  }

  // The errorMessage stamp surfaces the issue in the dashboard. We split by
  // runner freshness so the message reflects what's actually broken:
  //   - runner stale  → the whole lease is suspect ("ingress unreachable")
  //   - runner fresh  → only the inbound path is broken; the runner is alive
  //                     but external clients can't reach it. Without this,
  //                     the dashboard would show "Online" while every URL
  //                     hangs (the gcnlab.fyi case the user reported).
  const errorMessage = runnerFresh
    ? 'function routes unreachable through this provider — redeploy to retry on a healthier one'
    : `ingress unreachable for ${FAILURES_BEFORE_CLOSE} consecutive probes`;
  await db
    .update(deployments)
    .set({ errorMessage })
    .where(and(eq(deployments.id, row.id), eq(deployments.state, 'live')));
  log.warn('reconciler flagged live deployment', {
    deploymentId: row.id,
    url,
    runnerSeenAt: row.runnerSeenAt,
    runnerFresh,
  });
}

function isProbeErrorMessage(msg: string | null): boolean {
  if (!msg) return false;
  return msg.startsWith('ingress unreachable') || msg.startsWith('function routes unreachable');
}

export function isRunnerFresh(runnerSeenAt: Date | null): boolean {
  if (!runnerSeenAt) return false;
  return Date.now() - runnerSeenAt.getTime() < RUNNER_FRESH_MS;
}

async function clearIngressErrorMessage(deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ errorMessage: null })
    .where(and(
      eq(deployments.id, deploymentId),
      eq(deployments.state, 'live'),
      or(
        like(deployments.errorMessage, 'ingress unreachable%'),
        like(deployments.errorMessage, 'function routes unreachable%')
      )
    ));
}

async function failStuckDeploy(row: DeploymentRow, ageMs: number): Promise<void> {
  const errorMessage = 'deployment stuck: pipeline did not complete within timeout';
  await db
    .update(deployments)
    .set({ state: 'failed', errorMessage })
    .where(
      and(
        eq(deployments.id, row.id),
        // Re-assert state to avoid a race where the pipeline transitioned
        // between our SELECT and this UPDATE.
        eq(deployments.state, row.state),
        lt(deployments.createdAt, new Date(Date.now() - STUCK_DEPLOY_TIMEOUT_MS))
      )
    );
  log.info('reconciler failed stuck deployment', {
    deploymentId: row.id,
    fromState: row.state,
    ageMs,
  });
}

async function probe(url: string): Promise<boolean> {
  // Reconciler tick: probe the runner's reserved health path and require a
  // strict 200 — see RUNNER_HEALTH_PATH comment above.
  return probeIngress(url, PROBE_TIMEOUT_MS, {
    path: RUNNER_HEALTH_PATH,
    requireStatus: 200,
  });
}

export type ProbeOptions = {
  /** Path to append to the URL (default: '' = bare host). */
  path?: string;
  /**
   * If set, only this exact status counts as success. If unset, any non-5xx
   * response is treated as reachable (the historical "is the ingress alive"
   * semantic used by the user-facing /ingress-reachable endpoint).
   */
  requireStatus?: number;
};

// Try HTTPS and HTTP in parallel. Akash providers vary — most audited ones
// terminate TLS on their global ingress, but plenty serve only plain HTTP and
// rely on a downstream proxy (Cloudflare / Caddy) for TLS. Probing only
// HTTPS was making perfectly reachable functions look unreachable, leaving
// the UI stuck on "Finalizing your endpoint". Promise.any returns as soon as
// either scheme succeeds; only when both fail do we return false.
export async function probeIngress(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
  options: ProbeOptions = {}
): Promise<boolean> {
  const bare = url.replace(/^https?:\/\//i, '');
  const path = options.path ?? '';
  const candidates = [`https://${bare}${path}`, `http://${bare}${path}`];
  try {
    await Promise.any(candidates.map((u) => probeOne(u, timeoutMs, options.requireStatus)));
    return true;
  } catch {
    return false;
  }
}

async function probeOne(
  url: string,
  timeoutMs: number,
  requireStatus: number | undefined
): Promise<true> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
      // Some provider middlebox stacks refuse requests with an empty or
      // default fetch UA. Identifying the probe is also useful in pod logs.
      headers: { 'user-agent': 'akash-functions-reconciler/1.0' },
    });
    if (requireStatus !== undefined) {
      if (res.status !== requireStatus) throw new Error(`status ${res.status}`);
    } else if (res.status >= 500) {
      throw new Error(`status ${res.status}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

export function toFetchUrl(uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;
  return `https://${uri}`;
}
