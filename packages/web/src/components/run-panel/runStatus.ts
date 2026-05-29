// Status derivation for python-job runs.
//
// D4 — the pill is computed from runOutcome + exitCode + state, NOT from state
// alone. Teardown flips `state` to `closed` within seconds of a job finishing,
// so relying on state would clobber the real result. runOutcome (written by
// /complete or cancel) is authoritative once present.

import type { DeploymentState, RunOutcome } from '@shared/types';

export type RunPillTone = 'running' | 'ok' | 'error' | 'neutral';

export type RunPill = {
  label: string;
  tone: RunPillTone;
  color: string;
  // True while the run is still in motion — drives spinners.
  active: boolean;
};

const TONE_COLOR: Record<RunPillTone, string> = {
  running: 'var(--warn, #f5a524)',
  ok: 'var(--ok)',
  error: 'var(--err, #e5484d)',
  neutral: 'var(--fg-subtle, #777)',
};

const ACTIVE_STATES: DeploymentState[] = ['pending', 'bidding', 'leased', 'running'];

export function isRunActive(state: DeploymentState, outcome?: RunOutcome): boolean {
  // A terminal outcome wins even if the lease hasn't closed yet.
  if (outcome) return false;
  return ACTIVE_STATES.includes(state);
}

export function computeRunPill(
  state: DeploymentState,
  outcome: RunOutcome | undefined,
  exitCode: number | undefined
): RunPill {
  // Outcome is authoritative once written (survives lease close).
  if (outcome === 'succeeded') {
    return { label: `Succeeded · Exit ${exitCode ?? 0}`, tone: 'ok', color: TONE_COLOR.ok, active: false };
  }
  if (outcome === 'failed') {
    return {
      label: `Failed · Exit ${exitCode ?? 1}`,
      tone: 'error',
      color: TONE_COLOR.error,
      active: false,
    };
  }
  if (outcome === 'canceled') {
    return { label: 'Canceled', tone: 'neutral', color: TONE_COLOR.neutral, active: false };
  }
  // No outcome yet — derive from lease state.
  if (ACTIVE_STATES.includes(state)) {
    return { label: 'Running', tone: 'running', color: TONE_COLOR.running, active: true };
  }
  if (state === 'failed') {
    return { label: 'Failed', tone: 'error', color: TONE_COLOR.error, active: false };
  }
  // 'closed' / 'live' with no outcome — treat as a finished run we can't grade.
  return { label: 'Finished', tone: 'neutral', color: TONE_COLOR.neutral, active: false };
}

// D5 — map a provisioning lease state to a human phase label.
export function phaseLabel(state: DeploymentState): string {
  switch (state) {
    case 'pending':
      return 'Leasing';
    case 'bidding':
      return 'Reserving GPU';
    case 'leased':
      return 'Pulling image / installing deps';
    case 'running':
      return 'Running';
    case 'live':
      return 'Running';
    case 'failed':
      return 'Failed';
    case 'closed':
      return 'Closed';
    default:
      return state;
  }
}

// Rough on-demand H100 price for a clearly-labeled client-side estimate. Not a
// billing figure — just a back-of-envelope so the user sees order of magnitude.
export const H100_HOURLY_USD = 2.5;

export function estimateCostUsd(durationMs: number): number {
  return (durationMs / 3_600_000) * H100_HOURLY_USD;
}

// Live duration in ms: startedAt → finishedAt (or now while still running).
export function runDurationMs(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return Math.max(0, end - start);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
