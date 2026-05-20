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
import { log } from '../lib/log';
import { recordProviderFailure, recordProviderSuccess } from './provider-health';

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
}

async function reconcileRow(row: DeploymentRow): Promise<void> {
  if (row.state === 'live') {
    await checkLiveReachability(row);
    return;
  }
  if (row.state === 'pending' || row.state === 'bidding' || row.state === 'leased') {
    const ageMs = Date.now() - row.createdAt.getTime();
    if (ageMs > STUCK_DEPLOY_TIMEOUT_MS) {
      await failStuckDeploy(row, ageMs);
    }
  }
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

  if (next < FAILURES_BEFORE_CLOSE) {
    log.warn('ingress probe failed', { deploymentId: row.id, url, strike: next, runnerFresh });
    return;
  }

  // Strike threshold reached. Attribute to the provider regardless of runner
  // freshness — the smoke probe is specific (exact path + strict 200), so 3
  // consecutive failures is a high-confidence "something between us and the
  // runner is broken" signal. When the runner heartbeat is fresh, that points
  // squarely at the provider's inbound ingress (gcnlab.fyi pattern observed
  // in testing: TCP open, request sent, response never returns); when stale,
  // the lease or our outbound may be at fault, but the provider is still the
  // most plausible blame and a 24h cooldown is bounded blast radius.
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
