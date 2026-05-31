// D1 — Autonomous teardown driver. Closes a job's Akash lease with NO browser
// open, using the user's own Console key cached (encrypted) at run-submit.
//
// Fired by:
//   1. POST /api/runner/complete/:fnId — seconds after the script exits.
//   2. The reconciler watchdog — for overrun / runner-silence / orphan runs.
//   3. drainPendingTeardowns() on GET /api/functions — the fallback that
//      retries with the request's FRESH key when the cached key was rotated.
//
// CAS-claimed via deployments.teardown_state so /complete and the reconciler
// can't double-close. run_outcome / exit_code are NEVER touched here (D4) —
// teardown only flips lease state to 'closed'.

import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { consoleApi } from './console-client';
import { markDseqClosed } from './dseq-audit';
import { evictWalletKeyIfIdle, getWalletKey, walletForDeployment } from './key-cache';

// Mark a run as needing teardown and kick the driver. Idempotent: a row already
// closing/done is left alone.
export async function requestTeardown(deploymentId: string): Promise<void> {
  await db
    .update(deployments)
    .set({ teardownState: 'requested' })
    .where(
      and(
        eq(deployments.id, deploymentId),
        // don't re-request once we're closing or done
        or(sql`${deployments.teardownState} is null`, eq(deployments.teardownState, 'requested'))
      )
    );
  // Fire-and-forget; failures land back in teardown_state='requested' for the
  // reconciler / drain to retry.
  void runTeardown(deploymentId).catch((err) =>
    log.warn('teardown: runTeardown threw', { err: String(err), deploymentId })
  );
}

// Close the lease for one run. CAS-claims the row, resolves a key (cached, or
// the supplied fresh override), closes on Akash, and marks the row closed.
export async function runTeardown(
  deploymentId: string,
  keyOverride?: string
): Promise<'done' | 'noop' | 'no-key' | 'failed'> {
  // CAS claim: requested → closing. Only one caller wins.
  const [claimed] = await db
    .update(deployments)
    .set({ teardownState: 'closing' })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.teardownState, 'requested')))
    .returning();
  if (!claimed) return 'noop';

  // Already closed on chain / no lease to close — just finalize.
  if (!claimed.dseq) {
    await finalizeClosed(deploymentId, claimed.closedAt);
    await maybeEvict(deploymentId);
    return 'done';
  }

  // Resolve the Console key: a caller-supplied fresh key wins (drain path),
  // else the encrypted cache (autonomous path).
  let akashKey = keyOverride ?? null;
  if (!akashKey) {
    const wallet = await walletForDeployment(deploymentId);
    if (wallet) akashKey = await getWalletKey(wallet);
  }
  if (!akashKey) {
    // No key available — leave it requested for the drain fallback to retry
    // with a fresh authed key.
    await db
      .update(deployments)
      .set({ teardownState: 'requested' })
      .where(eq(deployments.id, deploymentId));
    return 'no-key';
  }

  try {
    await consoleApi.closeDeployment(akashKey, claimed.dseq);
    await markDseqClosed(claimed.dseq);
    await finalizeClosed(deploymentId, claimed.closedAt);
    await maybeEvict(deploymentId);
    return 'done';
  } catch (err) {
    const attempts = (claimed.teardownAttempts ?? 0) + 1;
    const exhausted = attempts >= env.JOB_TEARDOWN_MAX_ATTEMPTS;
    log.warn('teardown: closeDeployment failed', {
      err: String(err),
      deploymentId,
      dseq: claimed.dseq,
      attempts,
      exhausted,
    });
    // On auth failure (rotated key) or transient error, drop back to
    // 'requested' so the drain retries with a fresh key — unless we've
    // exhausted attempts, in which case stop hammering (on-chain cross-check
    // is the last line of defense).
    await db
      .update(deployments)
      .set({
        teardownState: exhausted ? 'done' : 'requested',
        teardownAttempts: attempts,
      })
      .where(eq(deployments.id, deploymentId));
    return 'failed';
  }
}

async function finalizeClosed(deploymentId: string, existingClosedAt: Date | null): Promise<void> {
  await db
    .update(deployments)
    .set({
      state: 'closed',
      closedAt: existingClosedAt ?? new Date(),
      teardownState: 'done',
    })
    .where(eq(deployments.id, deploymentId));
}

async function maybeEvict(deploymentId: string): Promise<void> {
  const wallet = await walletForDeployment(deploymentId);
  if (wallet) await evictWalletKeyIfIdle(wallet);
}

// Fallback driver, run on GET /api/functions with the request's fresh key.
// Retries any run stuck in teardown_state='requested'. Belt-and-suspenders for
// the rotated-key case where the cached key can no longer authenticate.
export async function drainPendingTeardowns(freshKey?: string): Promise<number> {
  const pending = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.teardownState, 'requested'),
        eq(deployments.runKind, 'job'),
        notInArray(deployments.state, ['closed'])
      )
    );
  let drained = 0;
  for (const row of pending) {
    const result = await runTeardown(row.id, freshKey);
    if (result === 'done') drained += 1;
  }
  return drained;
}

// Shared close for the cancel path: close the lease and set a terminal outcome.
// Unlike teardown, cancel DOES write run_outcome (D4 — cancel is a real
// outcome, not just a lease close).
export async function cancelRunLease(deploymentId: string, akashKey: string): Promise<boolean> {
  const [dep] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!dep) return false;
  if (dep.dseq) {
    try {
      await consoleApi.closeDeployment(akashKey, dep.dseq);
      await markDseqClosed(dep.dseq);
    } catch (err) {
      log.warn('cancel: closeDeployment failed; marking row closed anyway', {
        err: String(err),
        deploymentId,
        dseq: dep.dseq,
      });
    }
  }
  await db
    .update(deployments)
    .set({
      state: 'closed',
      closedAt: new Date(),
      teardownState: 'done',
      // Only set canceled if not already terminal (idempotent vs a /complete
      // that raced in).
      runOutcome: dep.runOutcome ?? 'canceled',
      finishedAt: dep.finishedAt ?? new Date(),
    })
    .where(eq(deployments.id, deploymentId));
  const wallet = await walletForDeployment(deploymentId);
  if (wallet) await evictWalletKeyIfIdle(wallet);
  return true;
}
