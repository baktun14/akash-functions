// Auth middleware — extracts `Authorization: Bearer <api-key>` and exposes
// it to handlers as c.get('akashKey'). Computes ownerHash for query scoping.

import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export type AuthVars = {
  akashKey: string;
  ownerHash: string;
};

export function ownerHashFor(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export const requireAkashKey: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const auth = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } }, 401);
  }
  const key = auth.slice(7).trim();
  if (!key) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Empty bearer token' } }, 401);
  }
  c.set('akashKey', key);
  c.set('ownerHash', ownerHashFor(key));
  await next();
};
