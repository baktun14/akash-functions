// Match a proposed resource spec against the live online+audited provider set
// from /v1/providers, the same way the akash-bid-matcher skill does. The
// output answers two questions for the resource picker UI:
//
//   1. How many providers can fulfill this spec right now?
//   2. If 0 (or close to it), which single dimension is filtering the pool?
//
// "Match" here is deliberately optimistic — we only check that each constraint
// fits in *some* provider's currently-available capacity (active=in-use,
// available=free). Persistent storage is summed into the storage check via
// stats.storage.total.available. We don't run the full on-chain price-matrix
// logic; this is a coarse pre-flight filter.

import type { GpuSpec, ResourceRequest } from '@shared/types';
import type { ProviderRow } from './console-client';

export type Dimension = 'cpu' | 'memory' | 'storage' | 'gpu';

/** Active = online + audited. Anything else won't bid in practice. */
export function isActiveProvider(p: ProviderRow): boolean {
  return p.isOnline === true && p.isAudited === true;
}

/** Akash CPU stats are in milli-cores; "0.5 vCPU" → 500. */
export function normalizeCpuMilli(input: string): number {
  const num = parseFloat(String(input).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return 500;
  return Math.round(num * 1000);
}

/** Returns bytes for inputs like "512Mi", "1Gi", "1 GiB", "1024". */
export function normalizeSizeBytes(input: string): number {
  const s = String(input).replace(/\s+/g, '').replace(/iB$/i, 'i');
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toLowerCase();
  const mult: Record<string, number> = {
    '': 1,
    ki: 1024,
    mi: 1024 ** 2,
    gi: 1024 ** 3,
    ti: 1024 ** 4,
  };
  return Math.floor(n * (mult[unit] ?? 1));
}

function providerFits(
  p: ProviderRow,
  cpuMilli: number,
  memBytes: number,
  storBytes: number,
  gpu: GpuSpec | undefined
): boolean {
  if ((p.stats.cpu?.available ?? 0) < cpuMilli) return false;
  if ((p.stats.memory?.available ?? 0) < memBytes) return false;
  if ((p.stats.storage?.total?.available ?? 0) < storBytes) return false;
  if (gpu) {
    const gpuUnits = gpu.units ?? 1;
    if ((p.stats.gpu?.available ?? 0) < gpuUnits) return false;
    // Provider must list the exact vendor+model in its inventory.
    const has = (p.gpuModels ?? []).some(
      (g) =>
        g.vendor?.toLowerCase() === gpu.vendor.toLowerCase() &&
        g.model?.toLowerCase() === gpu.model.toLowerCase()
    );
    if (!has) return false;
  }
  return true;
}

export type FeasibilityResult = {
  matchingProviders: number;
  totalActiveProviders: number;
  bottleneck?: Dimension;
};

/**
 * Counts providers that match the spec. If 0 match, identifies the single
 * dimension that, if dropped from the constraint set, would unlock the most
 * providers — that's the one we tell the user to relax.
 */
export function evaluateFeasibility(
  providers: ProviderRow[],
  spec: ResourceRequest
): FeasibilityResult {
  const active = providers.filter(isActiveProvider);
  const cpu = normalizeCpuMilli(spec.cpu);
  const mem = normalizeSizeBytes(spec.memory);
  const stor = normalizeSizeBytes(spec.storage);
  const gpu = spec.gpu;

  const matching = active.filter((p) => providerFits(p, cpu, mem, stor, gpu)).length;

  if (matching > 0) {
    return { matchingProviders: matching, totalActiveProviders: active.length };
  }

  // No matches — drop one dimension at a time and see which restoration
  // unlocks the most providers. That's the bottleneck.
  const counts: Record<Dimension, number> = {
    cpu: active.filter((p) => providerFits(p, 0, mem, stor, gpu)).length,
    memory: active.filter((p) => providerFits(p, cpu, 0, stor, gpu)).length,
    storage: active.filter((p) => providerFits(p, cpu, mem, 0, gpu)).length,
    gpu: gpu
      ? active.filter((p) => providerFits(p, cpu, mem, stor, undefined)).length
      : 0,
  };

  let bottleneck: Dimension = 'cpu';
  let best = counts.cpu;
  for (const dim of ['memory', 'storage', 'gpu'] as Dimension[]) {
    if (counts[dim] > best) {
      bottleneck = dim;
      best = counts[dim];
    }
  }

  return {
    matchingProviders: 0,
    totalActiveProviders: active.length,
    // Only emit a bottleneck if at least one dimension would actually help;
    // otherwise every dimension is equally constrained (which is rare but
    // possible — e.g. zero active providers).
    bottleneck: best > 0 ? bottleneck : undefined,
  };
}
