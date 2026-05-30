// Pure decision logic for the wait-for-capacity feature. No DB, no env, no I/O —
// every function takes its inputs (including the relevant env thresholds via
// WaitPolicyConfig) as plain values so the policy is trivially unit-testable.
// The waiting-driver and reconciler call these with `env` values bound in.

export type WaitPolicyConfig = {
  /** Default cap when a row carries no explicit maxWaitMs. */
  defaultMaxWaitMs: number;
  /** Hard ceiling — no row may wait longer than this. */
  maxWaitMs: number;
  /** Floor — a wait always gets at least this long (≥ one burst window) so an
   *  opt-in deploy never fails near-instantly. */
  minWaitMs: number;
  /** A burst (one create→bid→lease attempt sequence) running longer than this is
   *  presumed dead/hung; the watchdog reclaims the row to `waiting`. Must exceed
   *  the worst-case LIVE burst wall-time or a still-running burst gets reclaimed
   *  and double-creates. */
  burstTimeoutMs: number;
};

const MINUTE = 60_000;

// Resolve a requested max-wait into the enforced cap: default when unset, then
// clamped to [floor, ceiling].
export function clampMaxWaitMs(
  requested: number | null | undefined,
  cfg: WaitPolicyConfig
): number {
  const wanted = requested == null ? cfg.defaultMaxWaitMs : requested;
  return Math.min(Math.max(wanted, cfg.minWaitMs), cfg.maxWaitMs);
}

// True once a waiting row has been waiting longer than its (clamped) cap. The
// anchor is `waitingSince` (set once on first entry to `waiting`), falling back
// to `createdAt` for rows that predate the column.
export function isWaitCapExceeded(
  args: {
    waitingSince: Date | null;
    createdAt: Date;
    maxWaitMs: number | null;
    now: Date;
  },
  cfg: WaitPolicyConfig
): boolean {
  const cap = clampMaxWaitMs(args.maxWaitMs, cfg);
  const anchor = args.waitingSince ?? args.createdAt;
  return args.now.getTime() - anchor.getTime() > cap;
}

// Backoff interval between bursts for the un-gated paths (CPU jobs + services),
// which have no cheap capacity pre-check. Grows in tiers with total elapsed
// wait time so a long wait does a few hundred bursts, not one per tick, and is
// capped at 10 minutes. (GPU jobs are throttled by the inventory gate instead.)
export function backoffIntervalMs(waitedMs: number): number {
  if (waitedMs < 5 * MINUTE) return 1 * MINUTE;
  if (waitedMs < 30 * MINUTE) return 2 * MINUTE;
  if (waitedMs < 2 * 60 * MINUTE) return 5 * MINUTE;
  return 10 * MINUTE;
}

// Whether an un-gated row is due for another burst: always if it has never
// bursted, otherwise once the backoff interval for its current wait age elapses.
export function shouldBurstNow(args: {
  waitedMs: number;
  sinceLastBurstMs: number | null;
}): boolean {
  if (args.sinceLastBurstMs == null) return true;
  return args.sinceLastBurstMs >= backoffIntervalMs(args.waitedMs);
}

// True when an in-flight burst has run past the supervisor timeout — the
// watchdog uses this to reclaim a crashed/hung burst back to `waiting` instead
// of failing it.
export function isBurstStale(
  args: { burstStartedAt: Date | null; now: Date },
  cfg: WaitPolicyConfig
): boolean {
  if (!args.burstStartedAt) return false;
  return args.now.getTime() - args.burstStartedAt.getTime() > cfg.burstTimeoutMs;
}
