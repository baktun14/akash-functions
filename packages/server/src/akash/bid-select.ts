// Pure bid-selection logic — no I/O, no db. Shared by the single-attempt deploy
// pipeline (createAndAcquireLease) and the multi-group GPU fan-out
// (runGpuMultiGroup). Kept dependency-free so it's trivially unit-testable.

import { JOB_GPU_PREFERENCE, type GpuSpec } from '@shared/types';
import type { Bid } from './console-client';

const byPrice = (a: Bid, b: Bid) => Number(a.price.amount) - Number(b.price.amount);
const isOpen = (b: Bid) => b.state === 'open' || b.state === 'active';

// Single-attempt selection (extracted verbatim from the deploy pipeline): among
// the open bids, prefer the cheapest non-blocklisted one; if EVERY open bid is
// from a blocklisted (cooldown) provider, fall back to the cheapest anyway
// (`usedFallback: true`) — a hard fail is worse UX than retrying on a flaky
// provider. Returns undefined when no bid is open yet (caller keeps polling).
export function selectEligibleBid(
  bids: Bid[],
  blocklisted: Set<string>
): { bid: Bid; usedFallback: boolean } | undefined {
  const open = bids.filter(isOpen);
  if (!open.length) return undefined;
  const eligible = open.filter((b) => !blocklisted.has(b.id.provider));
  if (eligible.length) return { bid: eligible.slice().sort(byPrice)[0]!, usedFallback: false };
  return { bid: open.slice().sort(byPrice)[0]!, usedFallback: true };
}

export type GpuGroupBids = { gseq: number; gpu: GpuSpec; bids: Bid[] };
export type GpuWinnerAttempt = { gseq: number; gpu: GpuSpec; bid: Bid };

// Map raw bids (tagged by gseq) back to their candidate group. The chain numbers
// gseq 1..N in ALPHABETICAL order of placement name (chain-sdk SDL.v3Groups()
// sorts `[...groups.keys()].sort()`), and buildSdl names the groups g00, g01, …
// in candidate order — so alphabetical order == candidate order, and candidate[i]
// is the group with gseq i+1, regardless of which groups actually drew a bid.
// (End-to-end re-confirmed by the Phase 0 spike when GPU capacity returns.)
export function groupBidsByCandidate(bids: Bid[], candidates: GpuSpec[]): GpuGroupBids[] {
  return candidates.map((gpu, i) => ({
    gseq: i + 1,
    gpu,
    bids: bids.filter((b) => b.id.gseq === i + 1),
  }));
}

// Multi-group winner ranking (decisions 3–4). `groups` is in candidate order —
// groups[0] is the requested GPU. Produces the ordered attempt list:
//   1. the requested group first IF it has a clean (non-blocklisted) eligible
//      bid — the user's pick can't be outranked;
//   2. then every other group with a clean eligible bid, best JOB_GPU_PREFERENCE
//      rank first (ties by cheaper bid).
// Each group contributes its cheapest eligible bid. Groups whose only bids are
// blocklisted are dropped (the fan-out never settles for a flaky provider — if
// nothing clean bids, the caller parks in `waiting`). The orchestrator walks the
// list, accepting the first lease that succeeds (fall-through on accept error).
export function selectGpuWinner(groups: GpuGroupBids[], blocklisted: Set<string>): GpuWinnerAttempt[] {
  const picks = groups
    .map((grp, i) => {
      const sel = selectEligibleBid(grp.bids, blocklisted);
      if (!sel || sel.usedFallback) return null; // only clean, non-blocklisted bids fan out
      const rank = JOB_GPU_PREFERENCE.indexOf(grp.gpu.model.toLowerCase());
      return {
        gseq: grp.gseq,
        gpu: grp.gpu,
        bid: sel.bid,
        isRequested: i === 0,
        rank: rank < 0 ? Number.MAX_SAFE_INTEGER : rank,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  picks.sort((a, b) => {
    if (a.isRequested !== b.isRequested) return a.isRequested ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return byPrice(a.bid, b.bid);
  });

  return picks.map(({ gseq, gpu, bid }) => ({ gseq, gpu, bid }));
}

// Decide whether the bid poll can stop. `ranked` is the current selectGpuWinner
// output; `requestedGseq` is the requested group's gseq (1). Rules:
//   - nothing eligible yet → keep polling (until the overall timeout);
//   - the requested group is the top pick → accept now (it can't be outranked,
//     so there's no reason to wait out the window);
//   - only a non-requested group is eligible → open a short collection window
//     (give a slightly-later requested/better-rank bid a chance), then accept
//     the best collected once the window elapses.
export function multiGroupPollOutcome(
  ranked: GpuWinnerAttempt[],
  requestedGseq: number,
  windowStartedAt: number | null,
  now: number,
  windowMs: number
): 'keep-polling' | 'open-window' | 'accept' {
  if (!ranked.length) return 'keep-polling';
  if (ranked[0]!.gseq === requestedGseq) return 'accept';
  if (windowStartedAt === null) return 'open-window';
  return now - windowStartedAt >= windowMs ? 'accept' : 'keep-polling';
}
