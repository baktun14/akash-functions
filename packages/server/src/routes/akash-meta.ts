// /api/gpu-models  — GPU dropdown options for the resource picker.
// /api/check-feasibility — "how many providers can fulfill this spec?"
//
// Both endpoints proxy to console-api.akash.network public reads
// (/v1/gpu, /v1/providers) and cache the upstream response in-process so a
// debounced UI doesn't hammer Console on every slider tick.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { FeasibilityCheck, GpuModelOption } from '@shared/types';
import {
  type GpuInventoryResponse,
  type ProviderRow,
  consoleApi,
} from '../akash/console-client';
import { evaluateFeasibility, isActiveProvider } from '../akash/bid-matcher';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

const GPU_TTL_MS = 5 * 60 * 1000;       // GPU inventory churns slowly
const PROVIDERS_TTL_MS = 60 * 1000;     // Provider stats can flip in <1min

type Cached<T> = { value: T; expiresAt: number };
let gpuCache: Cached<GpuInventoryResponse> | null = null;
let providersCache: Cached<ProviderRow[]> | null = null;

async function fetchGpu(apiKey: string): Promise<GpuInventoryResponse> {
  if (gpuCache && gpuCache.expiresAt > Date.now()) return gpuCache.value;
  const value = await consoleApi.getGpuModels(apiKey);
  gpuCache = { value, expiresAt: Date.now() + GPU_TTL_MS };
  return value;
}

async function fetchProviders(apiKey: string): Promise<ProviderRow[]> {
  if (providersCache && providersCache.expiresAt > Date.now()) {
    return providersCache.value;
  }
  const value = await consoleApi.getProviders(apiKey);
  providersCache = { value, expiresAt: Date.now() + PROVIDERS_TTL_MS };
  return value;
}

const FeasibilityBody = z.object({
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
  gpu: z
    .object({
      vendor: z.enum(['nvidia', 'amd']),
      model: z.string().min(1).max(40),
      units: z.number().int().positive().max(8).optional(),
    })
    .optional(),
});

export const akashMetaRouter = new Hono<{ Variables: AuthVars }>();

akashMetaRouter.use('*', requireAkashKey);

// GET /api/gpu-models — flat list of GPU models with availability counts.
// Filters out the "<UNKNOWN>" vendor bucket and models with 0 allocatable
// units. Cross-references /v1/providers so we only surface models that at
// least one online+audited provider actually lists.
akashMetaRouter.get('/gpu-models', async (c) => {
  const apiKey = c.get('akashKey');
  let inventory: GpuInventoryResponse;
  let providers: ProviderRow[];
  try {
    [inventory, providers] = await Promise.all([
      fetchGpu(apiKey),
      fetchProviders(apiKey),
    ]);
  } catch (err) {
    log.warn('console-api gpu/providers fetch failed', { err: String(err) });
    throw new HTTPException(502, { message: 'Could not load GPU inventory' });
  }

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

  // Sort: available > 0 first (so usable options surface), then by available
  // count desc so the most-likely-to-bid models lead.
  options.sort((a, b) => {
    if ((a.available > 0) !== (b.available > 0)) return a.available > 0 ? -1 : 1;
    if (a.available !== b.available) return b.available - a.available;
    return a.model.localeCompare(b.model);
  });

  return c.json(options);
});

// POST /api/check-feasibility — given a proposed resource spec, how many
// online+audited providers could fulfill it right now?
akashMetaRouter.post('/check-feasibility', zValidator('json', FeasibilityBody), async (c) => {
  const apiKey = c.get('akashKey');
  const spec = c.req.valid('json');

  let providers: ProviderRow[];
  try {
    providers = await fetchProviders(apiKey);
  } catch (err) {
    log.warn('console-api providers fetch failed', { err: String(err) });
    throw new HTTPException(502, { message: 'Could not load provider directory' });
  }

  const result = evaluateFeasibility(providers, spec);
  const body: FeasibilityCheck = {
    matchingProviders: result.matchingProviders,
    totalActiveProviders: result.totalActiveProviders,
    bottleneck: result.bottleneck,
  };
  return c.json(body);
});
