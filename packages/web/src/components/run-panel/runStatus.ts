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

// 'waiting' (wait-for-capacity) is active — keep the Cancel button + poll on so
// the user can stop a wait, and the pill keeps shimmering.
const ACTIVE_STATES: DeploymentState[] = ['pending', 'bidding', 'leased', 'running', 'waiting'];

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
  if (state === 'waiting') {
    return { label: 'Waiting for GPU', tone: 'running', color: TONE_COLOR.running, active: true };
  }
  if (ACTIVE_STATES.includes(state)) {
    return { label: 'Running', tone: 'running', color: TONE_COLOR.running, active: true };
  }
  if (state === 'failed') {
    return { label: 'Failed', tone: 'error', color: TONE_COLOR.error, active: false };
  }
  // 'closed' / 'live' with no outcome — treat as a finished run we can't grade.
  return { label: 'Finished', tone: 'neutral', color: TONE_COLOR.neutral, active: false };
}

// D5 — map a provisioning lease state to a human phase label. `gpuAttempt > 0`
// means the first GPU got no bids and we're hunting an available alternative.
export function phaseLabel(state: DeploymentState, gpuAttempt = 0): string {
  switch (state) {
    case 'pending':
      return 'Leasing';
    case 'bidding':
      return gpuAttempt > 0 ? 'Searching for another GPU' : 'Reserving GPU';
    case 'waiting':
      return 'Waiting for an available GPU';
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

// Rough on-demand $/hr by GPU class for a clearly-labeled client-side estimate.
// Mirrors the server's pricing tiers (sdl.ts pricingAmount). Not a billing
// figure — just order-of-magnitude. Datacenter rate is the default when the
// model is unknown.
const GPU_HOURLY_USD_DATACENTER = 2.5;
const GPU_HOURLY_USD_MIDTIER = 0.8;

export function gpuHourlyUsd(model?: string): number {
  if (!model) return GPU_HOURLY_USD_DATACENTER;
  const m = model.toLowerCase();
  // Datacenter / hopper / ada-class — checked first (rtx5090/rtx6000 live here).
  if (/^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(m)) {
    return GPU_HOURLY_USD_DATACENTER;
  }
  // Mid-tier consumer / workstation.
  if (/^(rtx|gtx|a5000|a4000|t4|p4|p40)/.test(m)) {
    return GPU_HOURLY_USD_MIDTIER;
  }
  return GPU_HOURLY_USD_DATACENTER;
}

export function estimateCostUsd(durationMs: number, gpuModel?: string): number {
  return (durationMs / 3_600_000) * gpuHourlyUsd(gpuModel);
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
