// One-shot migration: copy each function's latest functionVersions.envVars
// into the new encrypted function_variables table. Bumps variables_revision
// once per function so any live runner picks up the new env via the
// /api/runner/current/:fnId poll loop and respawns the user process with the
// freshly-fetched values.
//
// Idempotent: skips (functionId, key) pairs that already exist in
// function_variables. Safe to re-run after a partial failure.
//
// Usage:
//   npm run backfill-variables -w server [-- --dry-run]
//
// Requires MASTER_ENCRYPTION_KEY to be set in env. Aborts with a non-zero
// exit code if it isn't, rather than silently storing plaintext.

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { validateVariableKey } from '@shared/reserved-vars';
import { db, sqlClient } from '../src/db/client';
import { functionVariables, functionVersions, functions } from '../src/db/schema';
import { secrets } from '../src/lib/secrets';

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  // Pre-flight: confirm the cipher round-trips with the configured key.
  // Beats failing partway through the migration.
  try {
    const probe = secrets.encrypt('backfill-probe');
    if (secrets.decrypt(probe) !== 'backfill-probe') throw new Error('round-trip mismatch');
  } catch (err) {
    console.error(`Cipher pre-flight failed: ${(err as Error).message}`);
    console.error('Ensure MASTER_ENCRYPTION_KEY is set to a base64-encoded 32-byte key.');
    process.exit(1);
  }

  let inserted = 0;
  let skipped = 0;
  const fnRows = await db
    .select({ id: functions.id, name: functions.name })
    .from(functions);

  for (const fn of fnRows) {
    const [latest] = await db
      .select({ envVars: functionVersions.envVars })
      .from(functionVersions)
      .where(
        and(eq(functionVersions.functionId, fn.id), isNotNull(functionVersions.envVars))
      )
      .orderBy(desc(functionVersions.createdAt))
      .limit(1);

    const envVars = latest?.envVars ?? {};
    const keys = Object.keys(envVars);
    if (keys.length === 0) continue;

    const existingRows = await db
      .select({ key: functionVariables.key })
      .from(functionVariables)
      .where(eq(functionVariables.functionId, fn.id));
    const existingKeys = new Set(existingRows.map((r) => r.key));

    let insertedForThisFn = 0;
    for (const key of keys) {
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      const validation = validateVariableKey(key);
      if (validation) {
        console.warn(`[skip] fn=${fn.id} key=${key}: ${validation}`);
        skipped += 1;
        continue;
      }
      const value = envVars[key];
      if (typeof value !== 'string' || value.length === 0) {
        console.warn(`[skip] fn=${fn.id} key=${key}: empty/non-string value`);
        skipped += 1;
        continue;
      }

      let encrypted;
      try {
        encrypted = secrets.encrypt(value);
      } catch (err) {
        console.warn(`[skip] fn=${fn.id} key=${key}: encrypt failed: ${(err as Error).message}`);
        skipped += 1;
        continue;
      }

      if (!DRY_RUN) {
        await db.insert(functionVariables).values({
          functionId: fn.id,
          key,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
        });
      }
      insertedForThisFn += 1;
      inserted += 1;
    }

    if (insertedForThisFn > 0) {
      if (!DRY_RUN) {
        await db
          .update(functions)
          .set({ variablesRevision: sql`${functions.variablesRevision} + 1` })
          .where(eq(functions.id, fn.id));
      }
      console.log(`[ok] fn=${fn.id} (${fn.name}) inserted=${insertedForThisFn}`);
    }
  }

  console.log(`${DRY_RUN ? 'DRY RUN' : 'APPLIED'}: inserted=${inserted} skipped=${skipped} functions=${fnRows.length}`);
}

main()
  .then(() => sqlClient.end())
  .catch(async (err) => {
    console.error(err);
    await sqlClient.end();
    process.exit(1);
  });
