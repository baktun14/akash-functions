// Pure run-health rule. A job is healthy in every state EXCEPT the one limbo
// the UI couldn't otherwise see: it got a lease (`leased`) but the runner never
// heartbeat, so the container was scheduled and is failing to become ready
// (crash-loop / slow or failing image pull). Before a boot grace this is the
// normal "Starting — pulling image" phase; past the grace it's `unhealthy` —
// surfaced as a live badge so the user sees trouble well before the reconciler's
// 15-min boot-timeout writes the durable verdict. Never flags a terminal run.
//
// Pure (no DB/IO) so it's unit-testable; toRunRecord binds the row fields + the
// grace constant.

import type { RunHealth } from '@shared/types';

// How long a leased-but-not-yet-heartbeating job is given before it's flagged
// `unhealthy`. Well under JOB_BOOT_TIMEOUT_MS (15m) so the badge is an early
// warning, generous enough to cover a cold CUDA image pull + pip.
export const RUN_HEALTH_GRACE_MS = 4 * 60_000;

export function computeRunHealth(args: {
  runOutcome: string | null;
  state: string;
  runnerSeenAt: Date | null;
  /** Age anchor for "how long leased without a heartbeat" — the current burst's
   *  start (burstStartedAt) for a wait-for-capacity row, else createdAt. */
  anchor: Date;
  now: Date;
  graceMs: number;
}): RunHealth | undefined {
  // Terminal runs are never unhealthy — they have an outcome.
  if (args.runOutcome != null) return undefined;
  // Only the leased-but-silent limbo is interesting; every other state either
  // hasn't been scheduled yet (pending/bidding) or has booted (running/live).
  if (args.state !== 'leased' || args.runnerSeenAt != null) return undefined;
  const ageMs = args.now.getTime() - args.anchor.getTime();
  return ageMs > args.graceMs ? 'unhealthy' : 'starting';
}
