// /api/gpu-models  — GPU dropdown options for the resource picker.
// /api/check-feasibility — "how many providers can fulfill this spec?"
//
// Both endpoints proxy to console-api.akash.network public reads
// (/v1/gpu, /v1/providers). The cached fetches + the availability computation
// live in akash/gpu-inventory.ts so the deploy pipeline's GPU-fallback loop
// shares the same in-process cache.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { FeasibilityCheck } from '@shared/types';
import type { ProviderRow } from '../akash/console-client';
import { evaluateFeasibility } from '../akash/bid-matcher';
import { getAvailableGpuModels, getCachedProviders } from '../akash/gpu-inventory';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

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
akashMetaRouter.get('/gpu-models', async (c) => {
  const apiKey = c.get('akashKey');
  try {
    const options = await getAvailableGpuModels(apiKey);
    return c.json(options);
  } catch (err) {
    log.warn('console-api gpu/providers fetch failed', { err: String(err) });
    throw new HTTPException(502, { message: 'Could not load GPU inventory' });
  }
});

// POST /api/check-feasibility — given a proposed resource spec, how many
// online+audited providers could fulfill it right now?
akashMetaRouter.post('/check-feasibility', zValidator('json', FeasibilityBody), async (c) => {
  const apiKey = c.get('akashKey');
  const spec = c.req.valid('json');

  let providers: ProviderRow[];
  try {
    providers = await getCachedProviders(apiKey);
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
