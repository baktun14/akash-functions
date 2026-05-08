// /api/usage — proxies the Console API balance endpoint.
// /v1/balances returns USD-equivalent figures already; no AKT conversion needed.

import { Hono } from 'hono';
import type { UsageInfo } from '@shared/types';
import { consoleApi } from '../akash/console-client';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

export const usageRouter = new Hono<{ Variables: AuthVars }>();
usageRouter.use('*', requireAkashKey);

usageRouter.get('/', async (c) => {
  try {
    const b = await consoleApi.getBalances(c.get('akashKey'));
    // Burn-rate placeholder — Console doesn't expose this directly. Real impl
    // would sum monthlyCostUDenom across live leases / 30.
    const burnRatePerDay = +(b.deployments / 30).toFixed(2);
    const info: UsageInfo = { usd: b.total, act: 0, burnRatePerDay };
    return c.json(info);
  } catch (err) {
    log.warn('usage proxy failed, returning zero', { err: String(err) });
    return c.json<UsageInfo>({ usd: 0, act: 0, burnRatePerDay: 0 });
  }
});
