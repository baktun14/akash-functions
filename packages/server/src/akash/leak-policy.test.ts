import { describe, expect, it } from 'vitest';
import { isBootStalledBurst, isBurstCapExceeded, shouldCloseOrphanDseq } from './leak-policy';

describe('isBootStalledBurst', () => {
  it('is true when leased but the runner never heartbeat (crash-loop / image-pull failure)', () => {
    expect(isBootStalledBurst({ state: 'leased', runnerSeenAt: null })).toBe(true);
  });

  it('is false when leased and the runner has heartbeat (it booted)', () => {
    expect(isBootStalledBurst({ state: 'leased', runnerSeenAt: new Date() })).toBe(false);
  });

  it('is false for pending/bidding — never got capacity, safe to reclaim and retry', () => {
    expect(isBootStalledBurst({ state: 'pending', runnerSeenAt: null })).toBe(false);
    expect(isBootStalledBurst({ state: 'bidding', runnerSeenAt: null })).toBe(false);
  });

  it('is false once running/live/terminal (already past boot)', () => {
    expect(isBootStalledBurst({ state: 'running', runnerSeenAt: null })).toBe(false);
    expect(isBootStalledBurst({ state: 'live', runnerSeenAt: null })).toBe(false);
    expect(isBootStalledBurst({ state: 'closed', runnerSeenAt: null })).toBe(false);
  });
});

describe('isBurstCapExceeded', () => {
  it('is false below the cap', () => {
    expect(isBurstCapExceeded(0, 25)).toBe(false);
    expect(isBurstCapExceeded(24, 25)).toBe(false);
  });

  it('is true at or above the cap', () => {
    expect(isBurstCapExceeded(25, 25)).toBe(true);
    expect(isBurstCapExceeded(48, 25)).toBe(true);
  });
});

describe('shouldCloseOrphanDseq', () => {
  it('closes the current dseq once the parent run is terminal', () => {
    expect(
      shouldCloseOrphanDseq({
        parentRunTerminal: true,
        isCurrentDseq: true,
        alreadyStampedClosed: false,
        onChainActive: true,
      })
    ).toBe(true);
  });

  it('closes a superseded burst even while the run is still active (the dominant leak)', () => {
    expect(
      shouldCloseOrphanDseq({
        parentRunTerminal: false,
        isCurrentDseq: false,
        alreadyStampedClosed: false,
        onChainActive: true,
      })
    ).toBe(true);
  });

  it('never touches the current dseq of a still-live run (the active attempt)', () => {
    expect(
      shouldCloseOrphanDseq({
        parentRunTerminal: false,
        isCurrentDseq: true,
        alreadyStampedClosed: false,
        onChainActive: true,
      })
    ).toBe(false);
  });

  it('never re-closes an already-stamped dseq', () => {
    expect(
      shouldCloseOrphanDseq({
        parentRunTerminal: true,
        isCurrentDseq: false,
        alreadyStampedClosed: true,
        onChainActive: true,
      })
    ).toBe(false);
  });

  it('skips a dseq already gone from chain (just needs the closedAt stamp, not a close call)', () => {
    expect(
      shouldCloseOrphanDseq({
        parentRunTerminal: true,
        isCurrentDseq: false,
        alreadyStampedClosed: false,
        onChainActive: false,
      })
    ).toBe(false);
  });
});
