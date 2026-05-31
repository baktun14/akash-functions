import { describe, expect, it } from 'vitest';
import type { FunctionRecord, RunRecord } from '@shared/types';
import {
  jobTone,
  timeAgo,
  jobMatchesOutcome,
  sortJobsByRecency,
  applyRerun,
} from './runStatus';

// Minimal python-job record for status helpers. Only the fields the helpers
// read are interesting; the rest satisfy the type.
function job(partial: Partial<FunctionRecord>): FunctionRecord {
  return {
    id: 'j1',
    name: 'job',
    kind: 'python-job',
    image: 'ghcr.io/akash-network/python-runner',
    status: 'idle',
    ...partial,
  };
}

describe('jobTone', () => {
  it('shows Succeeded for a succeeded run', () => {
    expect(jobTone(job({ runOutcome: 'succeeded' })).label).toBe('Succeeded');
  });
  it('names a known exit code on failure (137 -> Out of memory)', () => {
    expect(jobTone(job({ runOutcome: 'failed', exitCode: 137 })).label).toBe(
      'Out of memory (137)'
    );
  });
  it('falls back to "Failed · Exit N" for an unknown exit code', () => {
    expect(jobTone(job({ runOutcome: 'failed', exitCode: 2 })).label).toBe(
      'Failed · Exit 2'
    );
  });
  it('shows Canceled for a canceled run', () => {
    expect(jobTone(job({ runOutcome: 'canceled' })).label).toBe('Canceled');
  });
  it('treats an offline lease with no outcome as Failed', () => {
    expect(jobTone(job({ status: 'offline' })).label).toBe('Failed');
  });
  it('shows Waiting for GPU while waiting for capacity', () => {
    expect(jobTone(job({ status: 'waiting' })).label).toBe('Waiting for GPU');
  });
  it('shows Running while the lease is pending/online with no outcome', () => {
    expect(jobTone(job({ status: 'pending' })).label).toBe('Running');
    expect(jobTone(job({ status: 'online' })).label).toBe('Running');
  });
  it('shows Finished for an idle lease with no gradeable outcome', () => {
    expect(jobTone(job({ status: 'idle' })).label).toBe('Finished');
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-05-31T12:00:00.000Z');
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it('renders an em dash when there is no timestamp', () => {
    expect(timeAgo(undefined, now)).toBe('—');
  });
  it('renders "just now" within the last minute', () => {
    expect(timeAgo(iso(30_000), now)).toBe('just now');
  });
  it('renders minutes', () => {
    expect(timeAgo(iso(5 * 60_000), now)).toBe('5m ago');
  });
  it('renders hours', () => {
    expect(timeAgo(iso(3 * 3_600_000), now)).toBe('3h ago');
  });
  it('renders days', () => {
    expect(timeAgo(iso(2 * 86_400_000), now)).toBe('2d ago');
  });
  it('clamps a future timestamp to "just now"', () => {
    expect(timeAgo(iso(-5_000), now)).toBe('just now');
  });
});

describe('jobMatchesOutcome', () => {
  it('matches everything under the "all" filter', () => {
    expect(jobMatchesOutcome(job({ runOutcome: 'succeeded' }), 'all')).toBe(true);
    expect(jobMatchesOutcome(job({ status: 'pending' }), 'all')).toBe(true);
    expect(jobMatchesOutcome(job({ runOutcome: 'canceled' }), 'all')).toBe(true);
  });
  it('matches a succeeded run only under "succeeded"', () => {
    const svc = job({ runOutcome: 'succeeded' });
    expect(jobMatchesOutcome(svc, 'succeeded')).toBe(true);
    expect(jobMatchesOutcome(svc, 'running')).toBe(false);
    expect(jobMatchesOutcome(svc, 'failed')).toBe(false);
  });
  it('matches a failed run under "failed"', () => {
    expect(jobMatchesOutcome(job({ runOutcome: 'failed', exitCode: 1 }), 'failed')).toBe(true);
  });
  it('treats an offline lease with no outcome as failed', () => {
    expect(jobMatchesOutcome(job({ status: 'offline' }), 'failed')).toBe(true);
  });
  it('matches in-flight leases under "running"', () => {
    expect(jobMatchesOutcome(job({ status: 'pending' }), 'running')).toBe(true);
    expect(jobMatchesOutcome(job({ status: 'online' }), 'running')).toBe(true);
    expect(jobMatchesOutcome(job({ status: 'waiting' }), 'running')).toBe(true);
  });
  it('keeps a canceled run out of running/succeeded/failed', () => {
    const svc = job({ runOutcome: 'canceled' });
    expect(jobMatchesOutcome(svc, 'running')).toBe(false);
    expect(jobMatchesOutcome(svc, 'succeeded')).toBe(false);
    expect(jobMatchesOutcome(svc, 'failed')).toBe(false);
  });
});

describe('sortJobsByRecency', () => {
  it('orders most-recent first by updatedAt', () => {
    const older = job({ id: 'older', updatedAt: '2026-05-30T00:00:00.000Z' });
    const newer = job({ id: 'newer', updatedAt: '2026-05-31T00:00:00.000Z' });
    expect(sortJobsByRecency([older, newer]).map((s) => s.id)).toEqual(['newer', 'older']);
  });
  it('falls back to createdAt when updatedAt is absent', () => {
    const a = job({ id: 'a', createdAt: '2026-05-29T00:00:00.000Z' });
    const b = job({ id: 'b', updatedAt: '2026-05-31T00:00:00.000Z' });
    expect(sortJobsByRecency([a, b]).map((s) => s.id)).toEqual(['b', 'a']);
  });
  it('sorts records with no timestamps last', () => {
    const dated = job({ id: 'dated', updatedAt: '2026-05-31T00:00:00.000Z' });
    const undatedA = job({ id: 'u1' });
    const undatedB = job({ id: 'u2' });
    expect(sortJobsByRecency([undatedA, dated, undatedB])[0]!.id).toBe('dated');
  });
  it('does not mutate the input array', () => {
    const older = job({ id: 'older', updatedAt: '2026-05-30T00:00:00.000Z' });
    const newer = job({ id: 'newer', updatedAt: '2026-05-31T00:00:00.000Z' });
    const input = [older, newer];
    sortJobsByRecency(input);
    expect(input.map((s) => s.id)).toEqual(['older', 'newer']);
  });
});

function run(partial: Partial<RunRecord>): RunRecord {
  return {
    runId: 'r1',
    functionId: 'j1',
    versionId: 'v1',
    state: 'pending',
    createdAt: '2026-05-31T00:00:00.000Z',
    ...partial,
  };
}

describe('applyRerun', () => {
  it('clears the previous terminal outcome and exit code so the pill stops showing the old result', () => {
    const next = applyRerun(job({ runOutcome: 'failed', exitCode: 137 }), run({ runId: 'r2' }));
    expect(next.runOutcome).toBeUndefined();
    expect(next.exitCode).toBeUndefined();
  });
  it('marks the row pending for a normal new run', () => {
    expect(applyRerun(job({ status: 'idle' }), run({ state: 'pending' })).status).toBe('pending');
  });
  it('marks the row waiting when the rerun parks in wait-for-capacity', () => {
    expect(applyRerun(job({ status: 'idle' }), run({ state: 'waiting' })).status).toBe('waiting');
  });
  it('points the row at the new run id', () => {
    const next = applyRerun(job({ latestDeploymentId: 'old' }), run({ runId: 'r2' }));
    expect(next.latestDeploymentId).toBe('r2');
    expect(next.deploymentId).toBe('r2');
  });
  it('preserves identity fields', () => {
    const next = applyRerun(job({ id: 'keep', name: 'my-job' }), run({}));
    expect(next.id).toBe('keep');
    expect(next.name).toBe('my-job');
    expect(next.kind).toBe('python-job');
  });
});
