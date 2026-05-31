// Append-only dseq audit log — the deployment-leak safety net.
//
// `deployments.dseq` is a single column that gets nulled on every
// reclaim-to-`waiting`, so once a wait-for-capacity run re-bursts, the prior
// on-chain deployment is no longer reachable from the row and nothing closes
// it (escrow burns until depletion). This module records EVERY dseq the app
// creates into `deployment_dseqs` (never nulled), stamps `closedAt` only after
// a close is confirmed, exposes the per-run burst count for the runaway
// backstop, and runs a shared-wallet-safe orphan sweep that closes only
// dseqs we provably created.

import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { deploymentDseqs, deployments } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { consoleApi } from './console-client';
import { getWalletKey, walletForDeployment } from './key-cache';
import { shouldCloseOrphanDseq } from './leak-policy';

// Record an on-chain deployment the app just created. Called the moment
// `createDeployment` returns a dseq, before any close can happen. Idempotent on
// the dseq unique index (a dseq is globally unique, so a retried insert is a
// no-op rather than a duplicate burst).
export async function recordDseqCreated(deploymentId: string, dseq: string): Promise<void> {
  await db
    .insert(deploymentDseqs)
    .values({ deploymentId, dseq })
    .onConflictDoNothing({ target: deploymentDseqs.dseq });
}

// Stamp a dseq closed — ONLY call after a close is confirmed on-chain (or the
// deployment is observed already gone). Idempotent: only stamps still-open rows.
export async function markDseqClosed(dseq: string | undefined | null): Promise<void> {
  if (!dseq) return;
  await db
    .update(deploymentDseqs)
    .set({ closedAt: new Date() })
    .where(and(eq(deploymentDseqs.dseq, dseq), isNull(deploymentDseqs.closedAt)));
}

// Total on-chain deployments minted for a run (initial launch + every reclaim
// re-burst). This is the burst count the runaway backstop caps.
export async function countDseqsForDeployment(deploymentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deploymentDseqs)
    .where(eq(deploymentDseqs.deploymentId, deploymentId));
  return row?.n ?? 0;
}

// Shared-wallet-safe orphan sweep. Scans open audit rows past a grace window
// (so an in-flight burst's just-created dseq is never mistaken for an orphan),
// and for each that the policy says is an orphan AND is still active on-chain,
// closes it and stamps `closedAt`. Touches ONLY dseqs in our audit log, so it
// is safe to run against the user's general (non-app-exclusive) wallet.
//
// Runs in both homes (mirroring teardown): the keyless reconciler with the
// cached wallet key (autonomous), and the authed `GET /api/functions` drain
// with a fresh key (backstop for the rotated-key case). Returns the count
// closed this pass.
export async function sweepOrphanDseqs(keyOverride?: string): Promise<number> {
  // 2× the burst-supervisor timeout guarantees any in-flight burst has either
  // leased or been reclaimed before its dseq is eligible — eliminates the race
  // where a freshly-created dseq looks "superseded" before `deployments.dseq`
  // catches up.
  const cutoff = new Date(Date.now() - env.WAIT_FOR_CAPACITY_BURST_TIMEOUT_MS * 2);

  const rows = await db
    .select({
      dseq: deploymentDseqs.dseq,
      deploymentId: deploymentDseqs.deploymentId,
      depState: deployments.state,
      depRunOutcome: deployments.runOutcome,
      depCurrentDseq: deployments.dseq,
    })
    .from(deploymentDseqs)
    .innerJoin(deployments, eq(deploymentDseqs.deploymentId, deployments.id))
    .where(and(isNull(deploymentDseqs.closedAt), lt(deploymentDseqs.createdAt, cutoff)));

  let closed = 0;
  for (const row of rows) {
    const parentRunTerminal =
      row.depRunOutcome != null || row.depState === 'closed' || row.depState === 'failed';
    const isCurrentDseq = row.depCurrentDseq === row.dseq;

    // Cheap DB-only pre-filter: skip rows that can't be orphans (the live run's
    // current attempt) before paying for a key + an on-chain read.
    if (!parentRunTerminal && isCurrentDseq) continue;

    const wallet = await walletForDeployment(row.deploymentId);
    const key = keyOverride ?? (wallet ? await getWalletKey(wallet) : null);
    if (!key) continue; // no key → leave for the authed drain pass

    // Verify still-active on-chain before acting — never close off a stale row.
    let onChainActive = false;
    try {
      const detail = await consoleApi.getDeployment(key, row.dseq);
      onChainActive = detail.deployment.state === 'active';
    } catch (err) {
      // Gone (404) / unreadable → as far as we can tell it's already closed.
      log.info('sweep: getDeployment failed; stamping dseq as gone', {
        deploymentId: row.deploymentId,
        dseq: row.dseq,
        err: String(err),
      });
      await markDseqClosed(row.dseq);
      continue;
    }

    if (
      !shouldCloseOrphanDseq({ parentRunTerminal, isCurrentDseq, alreadyStampedClosed: false, onChainActive })
    ) {
      // Not active anymore → just record that it's closed.
      if (!onChainActive) await markDseqClosed(row.dseq);
      continue;
    }

    try {
      await consoleApi.closeDeployment(key, row.dseq);
      await markDseqClosed(row.dseq);
      closed += 1;
      log.warn('sweep: closed orphan deployment', {
        deploymentId: row.deploymentId,
        dseq: row.dseq,
        parentRunTerminal,
        superseded: !isCurrentDseq,
      });
    } catch (err) {
      // Leave open; next pass retries.
      log.warn('sweep: closeDeployment failed; leaving for retry', {
        deploymentId: row.deploymentId,
        dseq: row.dseq,
        err: String(err),
      });
    }
  }
  return closed;
}
