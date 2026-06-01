// Status derivation for python-job runs.
//
// D4 — the pill is computed from runOutcome + exitCode + state, NOT from state
// alone. Teardown flips `state` to `closed` within seconds of a job finishing,
// so relying on state would clobber the real result. runOutcome (written by
// /complete or cancel) is authoritative once present.

import type { DeploymentState, FunctionRecord, RunOutcome, RunRecord } from '@shared/types';

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

// Common process exit codes worth naming. 128+N = killed by signal N.
const EXIT_LABELS: Record<number, string> = {
  137: 'Out of memory',   // 128 + 9  (SIGKILL — usually OOM-killed)
  143: 'Terminated',      // 128 + 15 (SIGTERM)
  139: 'Segfault',        // 128 + 11 (SIGSEGV)
  130: 'Interrupted',     // 128 + 2  (SIGINT / Ctrl-C)
  127: 'Command not found',
};

// Failure pill text: name the code when we recognize it, keep the number for
// the long tail. e.g. 137 -> "Out of memory (137)", 1 -> "Failed · Exit 1".
export function failureLabel(exitCode: number | undefined): string {
  const code = exitCode ?? 1;
  const named = EXIT_LABELS[code];
  return named ? `${named} (${code})` : `Failed · Exit ${code}`;
}

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
    return { label: 'Succeeded', tone: 'ok', color: TONE_COLOR.ok, active: false };
  }
  if (outcome === 'failed') {
    return {
      label: failureLabel(exitCode),
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

// ── python-job LIST helpers (function-record level) ──
//
// These operate on the FunctionRecord list rows (not deployment rows) and back
// the Jobs section's list + outcome filter. They mirror computeRunPill's
// outcome-over-state precedence (D4) so a row's pill and its filter bucket can
// never disagree.

// Pill for a job ROW: the latest run's outcome (runOutcome + exitCode), falling
// back to the lease status while the run is still in flight. No ingress URL, no
// runner-outdated nudge — those are service-only concepts (D6).
export function jobTone(svc: FunctionRecord): { color: string; label: string } {
  const outcome: RunOutcome | undefined = svc.runOutcome;
  if (outcome === 'succeeded') {
    return { color: 'var(--ok)', label: 'Succeeded' };
  }
  if (outcome === 'failed') {
    return { color: 'var(--err, #e5484d)', label: failureLabel(svc.exitCode) };
  }
  if (outcome === 'canceled') {
    return { color: 'var(--fg-subtle, #777)', label: 'Canceled' };
  }
  if (svc.status === 'offline') {
    return { color: 'var(--err, #e5484d)', label: 'Failed' };
  }
  if (svc.status === 'waiting') {
    return { color: 'var(--warn, #f5a524)', label: 'Waiting for GPU' };
  }
  if (svc.status === 'pending' || svc.status === 'online') {
    return { color: 'var(--warn, #f5a524)', label: 'Running' };
  }
  return { color: 'var(--fg-subtle, #777)', label: 'Finished' };
}

export type JobOutcomeFilter = 'all' | 'running' | 'succeeded' | 'failed';

// Does a job row belong under the given outcome filter? Mirrors jobTone's
// branches so the filter and the displayed pill never disagree. A canceled run
// only surfaces under "all".
export function jobMatchesOutcome(svc: FunctionRecord, filter: JobOutcomeFilter): boolean {
  if (filter === 'all') return true;
  const outcome = svc.runOutcome;
  if (filter === 'succeeded') return outcome === 'succeeded';
  if (filter === 'failed') return outcome === 'failed' || (!outcome && svc.status === 'offline');
  // 'running' — no terminal outcome yet and the lease is still in motion.
  return (
    !outcome &&
    (svc.status === 'pending' || svc.status === 'online' || svc.status === 'waiting')
  );
}

// Recency key for a job row: updatedAt, falling back to createdAt; 0 when
// neither is present (sorts such rows last).
function recencyTs(svc: FunctionRecord): number {
  const iso = svc.updatedAt ?? svc.createdAt;
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// Most-recent first. Returns a new array — never mutates the input.
export function sortJobsByRecency(jobs: FunctionRecord[]): FunctionRecord[] {
  return jobs.slice().sort((a, b) => recencyTs(b) - recencyTs(a));
}

// Compact relative time for the jobs list "Last run" column. `now` (ms) is
// injected to stay deterministic and match runDurationMs's style. Future
// timestamps clamp to "just now"; a missing/unparseable value renders an em dash.
export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor(Math.max(0, now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// Optimistic row update when a job is re-run from the RunPanel. Clears the
// previous terminal outcome/exit so the list pill stops showing the old result,
// points the row at the new run, and sets a transient status — which both reads
// as Running/Waiting in the list AND flips useFunctions back to fast polling.
// The caller's refresh() then reconciles authoritative fields (timestamps,
// ordering). Without this, the list keeps the stale pill until a manual refresh.
export function applyRerun(svc: FunctionRecord, run: RunRecord): FunctionRecord {
  return {
    ...svc,
    status: run.state === 'waiting' ? 'waiting' : 'pending',
    runOutcome: undefined,
    exitCode: undefined,
    deploymentId: run.runId,
    latestDeploymentId: run.runId,
  };
}
