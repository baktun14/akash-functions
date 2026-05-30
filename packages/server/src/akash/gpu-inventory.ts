// Shared GPU / provider inventory — cached Console reads + availability helpers.
//
// Centralizes the in-process caches (GPU inventory + provider directory) and
// the "which GPU models can actually bid right now" computation, so BOTH the
// /api/gpu-models route AND the deploy pipeline's GPU-fallback loop hit one
// cache instead of double-fetching console-api.akash.network.

import { JOB_GPU_PREFERENCE } from '@shared/types';
import type { GpuModelOption, GpuSpec } from '@shared/types';
import {
  type GpuInventoryResponse,
  type ProviderRow,
  consoleApi,
} from './console-client';
import { isActiveProvider } from './bid-matcher';

const GPU_TTL_MS = 5 * 60 * 1000; // GPU inventory churns slowly
const PROVIDERS_TTL_MS = 60 * 1000; // Provider stats can flip in <1min

type Cached<T> = { value: T; expiresAt: number };
let gpuCache: Cached<GpuInventoryResponse> | null = null;
let providersCache: Cached<ProviderRow[]> | null = null;

async function fetchGpu(apiKey: string): Promise<GpuInventoryResponse> {
  if (gpuCache && gpuCache.expiresAt > Date.now()) return gpuCache.value;
  const value = await consoleApi.getGpuModels(apiKey);
  gpuCache = { value, expiresAt: Date.now() + GPU_TTL_MS };
  return value;
}

// Cached provider directory. Exposed so /check-feasibility shares this cache
// instead of keeping its own copy.
export async function getCachedProviders(apiKey: string): Promise<ProviderRow[]> {
  if (providersCache && providersCache.expiresAt > Date.now()) {
    return providersCache.value;
  }
  const value = await consoleApi.getProviders(apiKey);
  providersCache = { value, expiresAt: Date.now() + PROVIDERS_TTL_MS };
  return value;
}

// Flat list of GPU models with availability counts. Filters out the
// "<UNKNOWN>" vendor bucket and models with 0 allocatable units, and
// cross-references the provider directory so we only surface models that at
// least one online+audited provider actually lists. Sorted available-first so
// the most-likely-to-bid models lead.
export async function getAvailableGpuModels(apiKey: string): Promise<GpuModelOption[]> {
  const [inventory, providers] = await Promise.all([
    fetchGpu(apiKey),
    getCachedProviders(apiKey),
  ]);

  // Build a vendor+model set from active providers — defends against the
  // inventory listing a model whose only provider went offline.
  const activeModels = new Set<string>();
  for (const p of providers) {
    if (!isActiveProvider(p)) continue;
    for (const g of p.gpuModels ?? []) {
      if (g.vendor && g.model) {
        activeModels.add(`${g.vendor.toLowerCase()}:${g.model.toLowerCase()}`);
      }
    }
  }

  const options: GpuModelOption[] = [];
  for (const [vendor, models] of Object.entries(inventory.gpus.details ?? {})) {
    const normalizedVendor = vendor.toLowerCase();
    if (normalizedVendor !== 'nvidia' && normalizedVendor !== 'amd') continue;
    for (const m of models) {
      if (!m.model) continue;
      if (m.allocatable <= 0) continue;
      const key = `${normalizedVendor}:${m.model.toLowerCase()}`;
      if (!activeModels.has(key)) continue;
      const available = Math.max(0, m.allocatable - m.allocated);
      options.push({
        vendor: normalizedVendor as 'nvidia' | 'amd',
        model: m.model,
        ram: m.ram,
        interface: m.interface,
        allocatable: m.allocatable,
        allocated: m.allocated,
        available,
      });
    }
  }

  // available > 0 first, then by available count desc, then by model name.
  options.sort((a, b) => {
    if ((a.available > 0) !== (b.available > 0)) return a.available > 0 ? -1 : 1;
    if (a.available !== b.available) return b.available - a.available;
    return a.model.localeCompare(b.model);
  });

  return options;
}

// Stable key for the fallback loop's tried-set: vendor + lowercased model.
export function gpuKey(g: { vendor: string; model: string }): string {
  return `${g.vendor}:${g.model.toLowerCase()}`;
}

// Datacenter / hopper / ada-class GPUs — kept in sync with the pricing tier in
// sdl.ts (pricingAmount). The fallback only ever substitutes within this class
// so a job is never silently dropped onto a small consumer card (rtx3060, t4…).
// Exported for the multi-group fan-out (buildMultiGroupGpuCandidates / runGpuMultiGroup).
export function isDatacenterClassGpu(model: string): boolean {
  return /^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(model.toLowerCase());
}

// Pick the next GPU to try in the fallback loop: among models with free capacity
// we haven't already tried, prefer JOB_GPU_PREFERENCE order (rough capability),
// then any other datacenter-class card by most-available. Returns null when no
// untried DATACENTER-class GPU is available — we never substitute onto a small
// consumer card.
export function pickNextGpu(models: GpuModelOption[], tried: Set<string>): GpuSpec | null {
  const avail = models.filter((m) => m.available > 0 && !tried.has(gpuKey(m)));
  for (const model of JOB_GPU_PREFERENCE) {
    const hit = avail.find((m) => m.model.toLowerCase() === model);
    if (hit) return { vendor: hit.vendor, model: hit.model };
  }
  const dc = avail
    .filter((m) => isDatacenterClassGpu(m.model))
    .sort((a, b) => b.available - a.available);
  return dc[0] ? { vendor: dc[0].vendor, model: dc[0].model } : null;
}

// Ordered candidate list for the multi-group fan-out: the requested GPU first
// (honor the user's pick), then every AVAILABLE datacenter-class model in
// JOB_GPU_PREFERENCE order (ties by most-available), deduped against the
// requested one and capped at `maxGroups`. Alternates inherit the requested
// unit count so every group asks for the same GPU count. runGpuMultiGroup emits
// one placement group per returned candidate, in this order.
export function buildMultiGroupGpuCandidates(
  available: GpuModelOption[],
  requested: GpuSpec,
  maxGroups = 6
): GpuSpec[] {
  const candidates: GpuSpec[] = [requested];
  const seen = new Set<string>([gpuKey(requested)]);
  const alternates = available
    .filter((m) => m.available > 0 && isDatacenterClassGpu(m.model) && !seen.has(gpuKey(m)))
    .sort((a, b) => {
      const ra = JOB_GPU_PREFERENCE.indexOf(a.model.toLowerCase());
      const rb = JOB_GPU_PREFERENCE.indexOf(b.model.toLowerCase());
      const pa = ra < 0 ? JOB_GPU_PREFERENCE.length : ra;
      const pb = rb < 0 ? JOB_GPU_PREFERENCE.length : rb;
      if (pa !== pb) return pa - pb;
      return b.available - a.available;
    });
  for (const m of alternates) {
    if (candidates.length >= maxGroups) break;
    if (seen.has(gpuKey(m))) continue;
    seen.add(gpuKey(m));
    candidates.push({ vendor: m.vendor, model: m.model, units: requested.units });
  }
  return candidates;
}
