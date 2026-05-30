import { describe, expect, it } from 'vitest';
import {
  backoffIntervalMs,
  clampMaxWaitMs,
  isBurstStale,
  isWaitCapExceeded,
  shouldBurstNow,
  type WaitPolicyConfig,
} from './wait-policy';

const cfg: WaitPolicyConfig = {
  defaultMaxWaitMs: 24 * 60 * 60_000, // 24h
  maxWaitMs: 7 * 24 * 60 * 60_000, // 7d ceiling
  minWaitMs: 5 * 60_000, // 5m floor
  burstTimeoutMs: 5 * 60_000, // 5m
};

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('clampMaxWaitMs', () => {
  it('falls back to the default when unset', () => {
    expect(clampMaxWaitMs(undefined, cfg)).toBe(cfg.defaultMaxWaitMs);
    expect(clampMaxWaitMs(null, cfg)).toBe(cfg.defaultMaxWaitMs);
  });

  it('clamps above the ceiling down to the ceiling', () => {
    expect(clampMaxWaitMs(30 * 24 * HOUR, cfg)).toBe(cfg.maxWaitMs);
  });

  it('clamps a sub-floor request up to the floor', () => {
    // A 5s wait would auto-fail near-instantly — floor guarantees one real attempt.
    expect(clampMaxWaitMs(5_000, cfg)).toBe(cfg.minWaitMs);
    expect(clampMaxWaitMs(0, cfg)).toBe(cfg.minWaitMs);
    expect(clampMaxWaitMs(-1, cfg)).toBe(cfg.minWaitMs);
  });

  it('passes a within-range request through unchanged', () => {
    expect(clampMaxWaitMs(12 * HOUR, cfg)).toBe(12 * HOUR);
  });
});

// Runs default wait-for-capacity ON, but with a shorter default budget than
// deploys. waitPolicyConfig() and runWaitPolicyConfig() differ ONLY in
// defaultMaxWaitMs; the floor/ceiling are shared. These cases lock that contract
// at the pure layer (the configs themselves live in waiting-driver.ts, which
// imports the DB and can't be unit-imported).
describe('run vs deploy default budget', () => {
  const deployCfg: WaitPolicyConfig = { ...cfg, defaultMaxWaitMs: 24 * HOUR };
  const runCfg: WaitPolicyConfig = { ...cfg, defaultMaxWaitMs: 2 * HOUR };

  it('a run with no explicit budget defaults to 2h, a deploy to 24h', () => {
    expect(clampMaxWaitMs(undefined, runCfg)).toBe(2 * HOUR);
    expect(clampMaxWaitMs(undefined, deployCfg)).toBe(24 * HOUR);
  });

  it('the shorter run default still sits inside the shared [floor, ceiling]', () => {
    expect(clampMaxWaitMs(undefined, runCfg)).toBeGreaterThanOrEqual(runCfg.minWaitMs);
    expect(clampMaxWaitMs(undefined, runCfg)).toBeLessThanOrEqual(runCfg.maxWaitMs);
  });

  it('an explicit per-run maxWaitMs overrides the run default (clamped)', () => {
    expect(clampMaxWaitMs(6 * HOUR, runCfg)).toBe(6 * HOUR); // user extends past 2h
    expect(clampMaxWaitMs(30 * 24 * HOUR, runCfg)).toBe(runCfg.maxWaitMs); // capped at 7d
  });
});

describe('isWaitCapExceeded', () => {
  const waitingSince = new Date('2026-01-01T00:00:00Z');

  it('is false before the cap elapses', () => {
    const now = new Date(waitingSince.getTime() + 23 * HOUR);
    expect(isWaitCapExceeded({ waitingSince, createdAt: waitingSince, maxWaitMs: null, now }, cfg)).toBe(false);
  });

  it('is true once now - waitingSince exceeds the (clamped) cap', () => {
    const now = new Date(waitingSince.getTime() + 25 * HOUR);
    expect(isWaitCapExceeded({ waitingSince, createdAt: waitingSince, maxWaitMs: null, now }, cfg)).toBe(true);
  });

  it('honors a per-row maxWaitMs over the default', () => {
    const now = new Date(waitingSince.getTime() + 2 * HOUR);
    expect(isWaitCapExceeded({ waitingSince, createdAt: waitingSince, maxWaitMs: HOUR, now }, cfg)).toBe(true);
  });

  it('falls back to createdAt when waitingSince is null', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 25 * HOUR);
    expect(isWaitCapExceeded({ waitingSince: null, createdAt, maxWaitMs: null, now }, cfg)).toBe(true);
  });
});

describe('backoffIntervalMs', () => {
  it('grows with elapsed wait time and never exceeds the cap', () => {
    const early = backoffIntervalMs(1 * MIN);
    const mid = backoffIntervalMs(45 * MIN);
    const late = backoffIntervalMs(5 * HOUR);
    expect(early).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(late);
    expect(late).toBeLessThanOrEqual(10 * MIN);
    expect(early).toBeGreaterThanOrEqual(MIN);
  });
});

describe('shouldBurstNow', () => {
  it('always bursts when no prior burst has fired', () => {
    expect(shouldBurstNow({ waitedMs: 0, sinceLastBurstMs: null })).toBe(true);
  });

  it('waits out the backoff interval between bursts', () => {
    // Early on, interval is ~1m; 30s since last burst → too soon.
    expect(shouldBurstNow({ waitedMs: 1 * MIN, sinceLastBurstMs: 30_000 })).toBe(false);
    expect(shouldBurstNow({ waitedMs: 1 * MIN, sinceLastBurstMs: 90_000 })).toBe(true);
  });
});

describe('isBurstStale', () => {
  const burstStartedAt = new Date('2026-01-01T00:00:00Z');

  it('is false within the burst-supervisor window', () => {
    const now = new Date(burstStartedAt.getTime() + 2 * MIN);
    expect(isBurstStale({ burstStartedAt, now }, cfg)).toBe(false);
  });

  it('is true once a burst exceeds the supervisor timeout', () => {
    const now = new Date(burstStartedAt.getTime() + 6 * MIN);
    expect(isBurstStale({ burstStartedAt, now }, cfg)).toBe(true);
  });

  it('is false when no burst is in flight', () => {
    expect(isBurstStale({ burstStartedAt: null, now: new Date() }, cfg)).toBe(false);
  });
});
