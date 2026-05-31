// Pure decision logic for GPU-run deployment-leak containment. No DB, no env,
// no I/O — every function takes plain values so the policy is unit-testable.
// The waiting-driver, reconciler, and orphan sweep call these with row fields
// and env thresholds bound in.
//
// Background: a wait-for-capacity GPU run that reached `leased` and then
// crash-looped (image-pull / boot failure) used to be reclaimed to `waiting`
// and re-bursted every cycle — each burst minting a fresh dseq — piling up
// dozens of paid GPU deployments. These predicates encode the three guards
// that stop that: (1) don't re-burst a burst that already got capacity, (2) a
// hard runaway backstop on total bursts per run, (3) a shared-wallet-safe rule
// for which logged dseqs the orphan sweep may close.

// True when a supervised wait-for-capacity burst reached `leased` (a provider
// gave it capacity) but the runner never heartbeat (`runnerSeenAt == null`).
// That means the container was scheduled but never became ready — a crash-loop
// or image-pull failure. Re-bursting is futile (the image is still broken) and
// is the direct generator of the deployment pile-up, so such a burst must
// fail-fast with a durable verdict instead of being reclaimed to `waiting`.
//
// A burst still in `pending`/`bidding` never got capacity → genuine no-capacity
// → safe to reclaim and retry (returns false).
export function isBootStalledBurst(args: {
  state: string;
  runnerSeenAt: Date | null;
}): boolean {
  return args.state === 'leased' && args.runnerSeenAt == null;
}

// Runaway backstop: true once a run has minted at least `maxBursts` on-chain
// deployments (counted from the append-only dseq audit log, which includes the
// initial launch dseq plus every reclaim re-burst). This is a last-resort guard
// against a pile-up if some other path regresses — NOT a tight bound on a
// legitimate multi-hour wait, so the default is generous.
export function isBurstCapExceeded(burstCount: number, maxBursts: number): boolean {
  return burstCount >= maxBursts;
}

// Sweep safety predicate. The orphan sweep runs on the user's GENERAL Console
// wallet (not app-exclusive), so it may ONLY close a dseq the app provably
// created (it is in our audit log) and is still active on-chain. Among those,
// a dseq is an orphan to close when EITHER:
//   - the parent run is terminal (the run ended; even its current dseq should
//     be closed), OR
//   - this dseq is NOT the parent deployment's current dseq — i.e. a SUPERSEDED
//     burst. This is the dominant leak: a wait-for-capacity run re-bursts, the
//     prior dseq is nulled off `deployments.dseq`, and nothing else can find it.
// The deployment's CURRENT dseq on a still-live run is left untouched (it's the
// active attempt). Anything not in our audit log is never touched at all.
export function shouldCloseOrphanDseq(args: {
  parentRunTerminal: boolean;
  isCurrentDseq: boolean;
  alreadyStampedClosed: boolean;
  onChainActive: boolean;
}): boolean {
  if (args.alreadyStampedClosed) return false;
  if (!args.onChainActive) return false;
  return args.parentRunTerminal || !args.isCurrentDseq;
}
