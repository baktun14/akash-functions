// Per-provider blocklist for automatic bid selection.
//
// The reconciler's smoke probe (GET /_akash_runner/health through the
// provider ingress) feeds this table: a successful probe is a positive signal,
// a 3rd-strike failure with the runner heartbeat already stale is a negative
// one. When consecutiveFailures crosses FAILURES_BEFORE_COOLDOWN, cooldownUntil
// is set COOLDOWN_MS into the future; pipeline.ts skips providers whose
// cooldown is still in effect.
//
// All writes use Postgres UPSERTs (INSERT ... ON CONFLICT ... DO UPDATE) so
// concurrent reconciler ticks on different deployments that share a provider
// don't race. Counters are mutated relative to the existing row via SQL
// expressions; we never read-modify-write from JS.
//
// Cooldown clears by timestamp expiry, not by a successful re-deploy — a
// blocked provider receives no traffic, so it can't earn a success signal to
// clear itself. The 24h window is long enough for an operator to notice and
// fix their ingress, short enough that we don't permanently shrink the
// provider pool over a one-off blip.

import { gt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { providerHealth } from '../db/schema';
import { log } from '../lib/log';

export const FAILURES_BEFORE_COOLDOWN = 3;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function recordProviderSuccess(address: string): Promise<void> {
  if (!address) return;
  await db
    .insert(providerHealth)
    .values({
      address,
      totalSuccesses: 1,
      lastSuccessAt: new Date(),
    })
    .onConflictDoUpdate({
      target: providerHealth.address,
      set: {
        consecutiveFailures: 0,
        totalSuccesses: sql`${providerHealth.totalSuccesses} + 1`,
        lastSuccessAt: new Date(),
        cooldownUntil: null,
        updatedAt: new Date(),
      },
    });
}

export async function recordProviderFailure(
  address: string,
  reason: string
): Promise<void> {
  if (!address) return;
  const now = new Date();
  // Compute cooldownUntil in SQL based on the post-increment value so we don't
  // need a follow-up SELECT. The CASE keeps existing cooldowns untouched when
  // we're still below the threshold (consecutive_failures + 1 < FAILURES_BEFORE_COOLDOWN).
  //
  // The cooldown timestamp is serialized as an ISO string + `::timestamptz`
  // cast because postgres.js refuses to bind a JS `Date` as a generic
  // parameter (it expects a string/Buffer when the binary type info isn't
  // carried through a free-form `sql` template — only Drizzle's typed
  // `.values()` / `.set()` paths know to format it). Without the cast every
  // call to this function would throw `ERR_INVALID_ARG_TYPE: Received an
  // instance of Date` and silently fail under `.catch(log.error)`.
  const cooldownAtIso = new Date(now.getTime() + COOLDOWN_MS).toISOString();
  const cooldownExpr = sql`CASE WHEN ${providerHealth.consecutiveFailures} + 1 >= ${FAILURES_BEFORE_COOLDOWN} THEN ${cooldownAtIso}::timestamptz ELSE ${providerHealth.cooldownUntil} END`;
  const rows = await db
    .insert(providerHealth)
    .values({
      address,
      consecutiveFailures: 1,
      totalFailures: 1,
      lastFailureAt: now,
      lastFailureReason: reason,
      // First-time failure: only set cooldown if the threshold is 1.
      cooldownUntil: FAILURES_BEFORE_COOLDOWN <= 1 ? new Date(now.getTime() + COOLDOWN_MS) : null,
    })
    .onConflictDoUpdate({
      target: providerHealth.address,
      set: {
        consecutiveFailures: sql`${providerHealth.consecutiveFailures} + 1`,
        totalFailures: sql`${providerHealth.totalFailures} + 1`,
        lastFailureAt: now,
        lastFailureReason: reason,
        cooldownUntil: cooldownExpr,
        updatedAt: now,
      },
    })
    .returning({
      consecutiveFailures: providerHealth.consecutiveFailures,
      cooldownUntil: providerHealth.cooldownUntil,
    });

  const row = rows[0];
  if (row && row.cooldownUntil && row.cooldownUntil.getTime() > now.getTime()) {
    log.warn('provider placed on cooldown', {
      address,
      reason,
      consecutiveFailures: row.consecutiveFailures,
      cooldownUntil: row.cooldownUntil.toISOString(),
    });
  }
}

export async function getBlocklistedProviders(): Promise<Set<string>> {
  const now = new Date();
  const rows = await db
    .select({ address: providerHealth.address })
    .from(providerHealth)
    .where(gt(providerHealth.cooldownUntil, now));
  return new Set(rows.map((r) => r.address));
}
