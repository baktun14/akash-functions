// Auth middleware — extracts `Authorization: Bearer <api-key>`, resolves the
// wallet address behind the key (the stable identity), and exposes both to
// handlers. Wallet address is the scoping identity for functions; rotating an
// API key for the same wallet does NOT lose access to data.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ConsoleApiError, resolveWalletAddress } from '../akash/console-client';
import { db } from '../db/client';
import { keyLinks } from '../db/schema';
import { log } from '../lib/log';

export type AuthVars = {
  akashKey: string;
  ownerHash: string;       // legacy: sha256(apiKey).slice(0,16). Still written by routes during the transition.
  apiKeyHash: string;      // alias of ownerHash; clearer name for new code.
  walletAddress: string;   // primary scoping identity (akash1…)
};

export function ownerHashFor(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// In-memory cache. TTL is generous because invalidation only matters if a key's
// wallet binding changes (Console doesn't currently support that).
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { walletAddress: string; expires: number }>();

export const requireAkashKey: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const auth = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } }, 401);
  }
  const key = auth.slice(7).trim();
  if (!key) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Empty bearer token' } }, 401);
  }
  const apiKeyHash = ownerHashFor(key);

  let walletAddress: string;
  try {
    walletAddress = await resolveWalletForKey(key, apiKeyHash);
  } catch (err) {
    if (err instanceof ConsoleApiError && err.status === 401) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Akash Console rejected the API key' } }, 401);
    }
    if (err instanceof ConsoleApiError) {
      log.error('failed to resolve wallet for key', {
        err: err.message,
        path: err.path,
        status: err.status,
        code: err.code,
        details: err.details,
        apiKeyHash,
      });
    } else {
      log.error('failed to resolve wallet for key', { err: String(err), apiKeyHash });
    }
    return c.json(
      { error: { code: 'IDENTITY_RESOLUTION_FAILED', message: 'Could not resolve wallet address for API key' } },
      502
    );
  }

  c.set('akashKey', key);
  c.set('apiKeyHash', apiKeyHash);
  c.set('ownerHash', apiKeyHash);
  c.set('walletAddress', walletAddress);
  await next();
};

async function resolveWalletForKey(apiKey: string, apiKeyHash: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(apiKeyHash);
  if (cached && cached.expires > now) return cached.walletAddress;

  // Persistent cache: this row was written the first time we ever resolved
  // this key. Survives server restarts.
  const [link] = await db
    .select()
    .from(keyLinks)
    .where(eq(keyLinks.apiKeyHash, apiKeyHash))
    .limit(1);
  if (link) {
    cache.set(apiKeyHash, { walletAddress: link.walletAddress, expires: now + TTL_MS });
    return link.walletAddress;
  }

  // Cache miss — go to Console.
  const walletAddress = await resolveWalletAddress(apiKey);
  // Best-effort persist; ON CONFLICT DO NOTHING in case of a race.
  await db
    .insert(keyLinks)
    .values({ apiKeyHash, walletAddress })
    .onConflictDoNothing({ target: keyLinks.apiKeyHash })
    .catch((err) => log.warn('failed to persist key_link', { err: String(err), apiKeyHash }));
  cache.set(apiKeyHash, { walletAddress, expires: now + TTL_MS });
  return walletAddress;
}
