// D1 — Encrypted, run-scoped cache of the user's OWN Akash Console API key.
//
// Why this exists: autonomous teardown (close a job's lease seconds after the
// script exits, with NO browser open) needs the user's Console key. But that
// key never lives anywhere outside an incoming authed request — `keyLinks`
// stores only a hash, and the reconciler is deliberately keyless. So at
// run-submit (an authed request that DOES carry the key) we cache it encrypted
// at rest, keyed to the wallet, refreshed on every authed request, and evict it
// when the wallet has no active runs. The teardown driver is the only reader;
// the key NEVER enters the pod.
//
// Threat model (see ADR): a server compromise exposes these cached credentials.
// Bounded by encryption-at-rest (same AES-256-GCM envelope as function
// variables) plus eviction when no runs are active.

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments, functions, walletConsoleKeys } from '../db/schema';
import { secrets } from '../lib/secrets';
import { log } from '../lib/log';

// Lease states that still need the key around (a teardown might fire). Once a
// run reaches one of the terminal states it no longer needs the cached key.
const ACTIVE_RUN_STATES = ['pending', 'bidding', 'leased', 'running'] as const;

// Upsert the wallet's Console key, encrypted. Idempotent and cheap — safe to
// call on every authed request. Never throws into the request path.
export async function cacheWalletKey(walletAddress: string, akashKey: string): Promise<void> {
  if (!walletAddress || !akashKey) return;
  try {
    const enc = secrets.encrypt(akashKey);
    await db
      .insert(walletConsoleKeys)
      .values({
        walletAddress,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: walletConsoleKeys.walletAddress,
        set: {
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          keyVersion: enc.keyVersion,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    // Caching is best-effort — a failure here must not break the user's
    // request. Worst case, teardown falls back to the poll-drain path.
    log.warn('key-cache: cacheWalletKey failed', { err: String(err), walletAddress });
  }
}

// Decrypt and return the cached Console key for a wallet, or null if none.
export async function getWalletKey(walletAddress: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(walletConsoleKeys)
    .where(eq(walletConsoleKeys.walletAddress, walletAddress))
    .limit(1);
  if (!row) return null;
  try {
    return secrets.decrypt({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
  } catch (err) {
    log.warn('key-cache: getWalletKey decrypt failed', { err: String(err), walletAddress });
    return null;
  }
}

// Resolve the wallet that owns a deployment (run) so the teardown driver can
// look up the right cached key.
export async function walletForDeployment(deploymentId: string): Promise<string | null> {
  const [row] = await db
    .select({ walletAddress: functions.walletAddress })
    .from(deployments)
    .innerJoin(functions, eq(deployments.functionId, functions.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row?.walletAddress ?? null;
}

// Drop the cached key once a wallet has no runs that could still need teardown.
// Called after a teardown completes. Best-effort.
export async function evictWalletKeyIfIdle(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  try {
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deployments)
      .innerJoin(functions, eq(deployments.functionId, functions.id))
      .where(
        and(
          eq(functions.walletAddress, walletAddress),
          eq(deployments.runKind, 'job'),
          notInArray(deployments.state, ['closed', 'failed']),
          // Only runs whose teardown isn't done yet keep the key alive.
          isNull(deployments.closedAt)
        )
      );
    if (Number(count) === 0) {
      await db.delete(walletConsoleKeys).where(eq(walletConsoleKeys.walletAddress, walletAddress));
    }
  } catch (err) {
    log.warn('key-cache: evictWalletKeyIfIdle failed', { err: String(err), walletAddress });
  }
}

export { ACTIVE_RUN_STATES };
