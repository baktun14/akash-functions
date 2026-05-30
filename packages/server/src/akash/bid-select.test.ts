import { describe, expect, it } from 'vitest';
import type { GpuSpec } from '@shared/types';
import type { Bid } from './console-client';
import {
  groupBidsByCandidate,
  multiGroupPollOutcome,
  selectEligibleBid,
  selectGpuWinner,
  type GpuGroupBids,
  type GpuWinnerAttempt,
} from './bid-select';

function mkBid(provider: string, amount: number, opts: { gseq?: number; state?: string } = {}): Bid {
  return {
    id: { owner: 'o', dseq: '100', gseq: opts.gseq ?? 1, oseq: 1, provider, bseq: 1 },
    state: opts.state ?? 'open',
    price: { denom: 'uact', amount: String(amount) },
    created_at: '2026-01-01',
  };
}
const gpu = (model: string): GpuSpec => ({ vendor: 'nvidia', model });

describe('selectEligibleBid', () => {
  it('returns the cheapest non-blocklisted open bid', () => {
    const picked = selectEligibleBid([mkBid('pA', 800), mkBid('pB', 300), mkBid('pC', 500)], new Set());
    expect(picked).toMatchObject({ usedFallback: false });
    expect(picked!.bid.id.provider).toBe('pB');
  });

  it('ignores bids that are neither open nor active', () => {
    const picked = selectEligibleBid([mkBid('pA', 100, { state: 'closed' }), mkBid('pB', 900)], new Set());
    expect(picked!.bid.id.provider).toBe('pB');
  });

  it('treats active bids as eligible', () => {
    const picked = selectEligibleBid([mkBid('pA', 200, { state: 'active' })], new Set());
    expect(picked!.bid.id.provider).toBe('pA');
  });

  it('falls back to the cheapest bid when every open bid is blocklisted', () => {
    const picked = selectEligibleBid([mkBid('bad1', 900), mkBid('bad2', 400)], new Set(['bad1', 'bad2']));
    expect(picked).toMatchObject({ usedFallback: true });
    expect(picked!.bid.id.provider).toBe('bad2');
  });

  it('returns undefined when there are no open bids', () => {
    expect(selectEligibleBid([mkBid('pA', 100, { state: 'closed' })], new Set())).toBeUndefined();
  });
});

describe('selectGpuWinner', () => {
  it('ranks the requested group first when it has an eligible bid, even if another GPU is cheaper/better', () => {
    const groups: GpuGroupBids[] = [
      { gseq: 1, gpu: gpu('a100'), bids: [mkBid('pA', 500, { gseq: 1 })] }, // requested (index 0)
      { gseq: 2, gpu: gpu('h100'), bids: [mkBid('pB', 100, { gseq: 2 })] }, // better rank + cheaper
    ];
    const result = selectGpuWinner(groups, new Set());
    expect(result.map((r) => r.gpu.model)).toEqual(['a100', 'h100']);
  });

  it('ranks non-requested groups by JOB_GPU_PREFERENCE when the requested group has no bid', () => {
    const groups: GpuGroupBids[] = [
      { gseq: 1, gpu: gpu('a100'), bids: [] }, // requested, no bid
      { gseq: 2, gpu: gpu('l40'), bids: [mkBid('pC', 100, { gseq: 2 })] }, // rank 4
      { gseq: 3, gpu: gpu('h100'), bids: [mkBid('pD', 900, { gseq: 3 })] }, // rank 1
    ];
    const result = selectGpuWinner(groups, new Set());
    expect(result.map((r) => r.gpu.model)).toEqual(['h100', 'l40']);
  });

  it('uses the cheapest eligible bid within each group', () => {
    const groups: GpuGroupBids[] = [
      { gseq: 1, gpu: gpu('a100'), bids: [mkBid('pA', 800, { gseq: 1 }), mkBid('pB', 300, { gseq: 1 })] },
    ];
    const result = selectGpuWinner(groups, new Set());
    expect(result[0]!.bid.id.provider).toBe('pB');
  });

  it('drops a group whose only bids are blocklisted (no fan-out fallback to flaky providers)', () => {
    const groups: GpuGroupBids[] = [
      { gseq: 1, gpu: gpu('a100'), bids: [mkBid('blocked', 100, { gseq: 1 })] }, // requested, only blocklisted
      { gseq: 2, gpu: gpu('h100'), bids: [mkBid('clean', 200, { gseq: 2 })] },
    ];
    const result = selectGpuWinner(groups, new Set(['blocked']));
    expect(result.map((r) => r.gpu.model)).toEqual(['h100']);
  });

  it('returns empty when no group has an eligible bid', () => {
    const groups: GpuGroupBids[] = [
      { gseq: 1, gpu: gpu('a100'), bids: [] },
      { gseq: 2, gpu: gpu('h100'), bids: [mkBid('x', 1, { gseq: 2, state: 'closed' })] },
    ];
    expect(selectGpuWinner(groups, new Set())).toEqual([]);
  });
});

describe('groupBidsByCandidate', () => {
  const candidates = [gpu('a100'), gpu('h100'), gpu('l40')];

  it('maps candidate[i] to gseq i+1 and collects its bids', () => {
    const bids = [mkBid('pA', 100, { gseq: 1 }), mkBid('pB', 200, { gseq: 3 })];
    const groups = groupBidsByCandidate(bids, candidates);
    expect(groups.map((g) => [g.gseq, g.gpu.model, g.bids.length])).toEqual([
      [1, 'a100', 1],
      [2, 'h100', 0],
      [3, 'l40', 1],
    ]);
  });

  it('routes a bid to the right candidate even when earlier groups got no bid', () => {
    const groups = groupBidsByCandidate([mkBid('pB', 200, { gseq: 2 })], candidates);
    expect(groups.find((g) => g.gpu.model === 'h100')!.bids).toHaveLength(1);
    expect(groups.find((g) => g.gpu.model === 'a100')!.bids).toHaveLength(0);
  });
});

describe('multiGroupPollOutcome', () => {
  const att = (gseq: number): GpuWinnerAttempt => ({ gseq, gpu: gpu('a100'), bid: mkBid('p', 1, { gseq }) });
  const W = 6000;

  it('keeps polling while no group has an eligible bid', () => {
    expect(multiGroupPollOutcome([], 1, null, 1000, W)).toBe('keep-polling');
  });

  it('accepts immediately when the requested group (gseq 1) is the top pick — it can’t be outranked', () => {
    expect(multiGroupPollOutcome([att(1)], 1, null, 1000, W)).toBe('accept');
  });

  it('opens a collection window on the first non-requested eligible bid', () => {
    expect(multiGroupPollOutcome([att(2)], 1, null, 1000, W)).toBe('open-window');
  });

  it('keeps polling until the collection window elapses', () => {
    expect(multiGroupPollOutcome([att(2)], 1, 1000, 1000 + 3000, W)).toBe('keep-polling');
  });

  it('accepts the best non-requested pick once the window elapses', () => {
    expect(multiGroupPollOutcome([att(2)], 1, 1000, 1000 + W, W)).toBe('accept');
  });
});
