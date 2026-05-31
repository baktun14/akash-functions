import { describe, expect, it } from 'vitest';
import { computeRunHealth, RUN_HEALTH_GRACE_MS } from './run-health';

const base = {
  runOutcome: null as string | null,
  state: 'leased',
  runnerSeenAt: null as Date | null,
  anchor: new Date('2026-05-30T00:00:00Z'),
  now: new Date('2026-05-30T00:00:00Z'),
  graceMs: RUN_HEALTH_GRACE_MS,
};

describe('computeRunHealth', () => {
  it('reports "starting" while leased, no heartbeat, still within the boot grace', () => {
    const now = new Date(base.anchor.getTime() + RUN_HEALTH_GRACE_MS - 1);
    expect(computeRunHealth({ ...base, now })).toBe('starting');
  });

  it('reports "unhealthy" once leased + no heartbeat past the grace (crash-loop / image-pull)', () => {
    const now = new Date(base.anchor.getTime() + RUN_HEALTH_GRACE_MS + 1);
    expect(computeRunHealth({ ...base, now })).toBe('unhealthy');
  });

  it('is undefined once the runner has heartbeat (it booted), even past grace', () => {
    const now = new Date(base.anchor.getTime() + RUN_HEALTH_GRACE_MS + 60_000);
    expect(computeRunHealth({ ...base, runnerSeenAt: new Date(), now })).toBeUndefined();
  });

  it('is undefined for non-leased states (pre-lease / running / live)', () => {
    expect(computeRunHealth({ ...base, state: 'bidding' })).toBeUndefined();
    expect(computeRunHealth({ ...base, state: 'running' })).toBeUndefined();
    expect(computeRunHealth({ ...base, state: 'live' })).toBeUndefined();
  });

  it('is undefined on any terminal run, regardless of state/heartbeat', () => {
    const past = new Date(base.anchor.getTime() + RUN_HEALTH_GRACE_MS + 60_000);
    expect(computeRunHealth({ ...base, runOutcome: 'failed', now: past })).toBeUndefined();
    expect(computeRunHealth({ ...base, runOutcome: 'succeeded', now: past })).toBeUndefined();
    expect(computeRunHealth({ ...base, runOutcome: 'canceled', now: past })).toBeUndefined();
  });
});
