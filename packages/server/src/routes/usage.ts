// /api/usage — proxies the Console wallet balance and converts to USD-first.

import { Hono } from 'hono';
import type { UsageInfo } from '@shared/types';
import { consoleApi } from '../akash/console-client';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

// Approximate AKT → USD price for the demo. Real implementation should pull
// from an oracle (e.g. CoinGecko).
const AKT_USD = 0.41;

export const usageRouter = new Hono<{ Variables: AuthVars }>();
usageRouter.use('*', requireAkashKey);

usageRouter.get('/', async (c) => {
  try {
    const balance = await consoleApi.getWalletBalance(c.get('akashKey'));
    const akt = balance.balances.find((b) => b.denom === 'uakt');
    const aktUnits = akt ? Number(akt.amount) / 1_000_000 : 0;
    const usd = +(aktUnits * AKT_USD).toFixed(2);
    // Burn-rate placeholder — real impl computes by summing live deployment costs.
    const burnRatePerDay = +(usd / 30).toFixed(2);
    const info: UsageInfo = { usd, act: aktUnits, burnRatePerDay };
    return c.json(info);
  } catch (err) {
    log.warn('usage proxy failed, returning zero', { err: String(err) });
    return c.json<UsageInfo>({ usd: 0, act: 0, burnRatePerDay: 0 });
  }
});
