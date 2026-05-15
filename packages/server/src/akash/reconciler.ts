// Background reconciler — runs every 60s to keep deployment rows honest.
//
// Two sweeps per pass, both DB-only (no Akash API; the user's API key is not
// available outside an authed request):
//
// 1. Reachability of state='live' rows. We HTTP GET the first ingress URI
//    with a 2s timeout. Any HTTP response counts as reachable; connection
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

import { and, eq, like, lt, notInArray } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments, type DeploymentRow } from '../db/schema';
import { log } from '../lib/log';

const TICK_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;
const FAILURES_BEFORE_CLOSE = 3;
const STUCK_DEPLOY_TIMEOUT_MS = 10 * 60_000;

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

  const reachable = await probe(toFetchUrl(url));
  if (reachable) {
    const hadFailures = failureCounts.delete(row.id);
    if (hadFailures || row.errorMessage?.startsWith('ingress unreachable')) {
      await db
        .update(deployments)
        .set({ errorMessage: null })
        .where(and(
          eq(deployments.id, row.id),
          eq(deployments.state, 'live'),
          like(deployments.errorMessage, 'ingress unreachable%')
        ));
    }
    return;
  }

  const next = (failureCounts.get(row.id) ?? 0) + 1;
  failureCounts.set(row.id, next);

  if (next < FAILURES_BEFORE_CLOSE) {
    log.warn('ingress probe failed', { deploymentId: row.id, url, strike: next });
    return;
  }

  const errorMessage = `ingress unreachable for ${FAILURES_BEFORE_CLOSE} consecutive probes`;
  await db
    .update(deployments)
    .set({ errorMessage })
    .where(and(eq(deployments.id, row.id), eq(deployments.state, 'live')));
  log.warn('reconciler flagged live deployment as unreachable', { deploymentId: row.id, url });
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
  return probeIngress(url, PROBE_TIMEOUT_MS);
}

// Try HTTPS and HTTP in parallel. Akash providers vary — most audited ones
// terminate TLS on their global ingress, but plenty serve only plain HTTP and
// rely on a downstream proxy (Cloudflare / Caddy) for TLS. Probing only
// HTTPS was making perfectly reachable functions look unreachable, leaving
// the UI stuck on "Finalizing your endpoint". Promise.any returns as soon as
// either scheme succeeds; only when both fail do we return false.
export async function probeIngress(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const bare = url.replace(/^https?:\/\//i, '');
  const candidates = [`https://${bare}`, `http://${bare}`];
  try {
    await Promise.any(candidates.map((u) => probeOne(u, timeoutMs)));
    return true;
  } catch {
    return false;
  }
}

async function probeOne(url: string, timeoutMs: number): Promise<true> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    if (res.status >= 500) throw new Error(`status ${res.status}`);
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

export function toFetchUrl(uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;
  return `https://${uri}`;
}
