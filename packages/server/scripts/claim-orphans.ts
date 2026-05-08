// One-shot recovery: re-stamps functions whose wallet_address is NULL onto a
// supplied wallet address. Use after the wallet-address migration to recover
// rows that were created under the old sha256(apiKey) ownerHash and had no
// wallet linked.
//
// Usage:
//   npm run claim-orphans -w server -- <wallet-address> [--owner-hash=<hex>] [--yes]
//
// Without --owner-hash, claims ALL rows with wallet_address IS NULL.
// Pass --yes to skip the confirmation prompt.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, sqlClient } from '../src/db/client';
import { functions, keyLinks } from '../src/db/schema';

type Args = {
  walletAddress: string;
  ownerHash?: string;
  yes: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let ownerHash: string | undefined;
  let yes = false;
  for (const a of argv) {
    if (a === '--yes' || a === '-y') yes = true;
    else if (a.startsWith('--owner-hash=')) ownerHash = a.slice('--owner-hash='.length);
    else if (a === '--help' || a === '-h') {
      console.log('usage: claim-orphans <wallet-address> [--owner-hash=<hex>] [--yes]');
      process.exit(0);
    } else positional.push(a);
  }
  const walletAddress = positional[0];
  if (!walletAddress) {
    console.error('error: wallet-address is required');
    console.error('usage: claim-orphans <wallet-address> [--owner-hash=<hex>] [--yes]');
    process.exit(2);
  }
  if (!walletAddress.startsWith('akash1')) {
    console.error(`warning: "${walletAddress}" does not look like an akash1… address — continuing anyway`);
  }
  return { walletAddress, ownerHash, yes };
}

async function main() {
  const { walletAddress, ownerHash, yes } = parseArgs(process.argv.slice(2));

  const condition = ownerHash
    ? and(isNull(functions.walletAddress), eq(functions.ownerHash, ownerHash))
    : isNull(functions.walletAddress);

  const candidates = await db
    .select({
      id: functions.id,
      name: functions.name,
      ownerHash: functions.ownerHash,
      createdAt: functions.createdAt,
      deletedAt: functions.deletedAt,
    })
    .from(functions)
    .where(condition);

  if (candidates.length === 0) {
    console.log('no orphaned functions found — nothing to claim');
    await sqlClient.end();
    return;
  }

  console.log(`found ${candidates.length} orphaned function(s) to claim onto ${walletAddress}:`);
  for (const c of candidates) {
    const tomb = c.deletedAt ? ' [deleted]' : '';
    console.log(`  - ${c.id}  name=${c.name}  ownerHash=${c.ownerHash}  createdAt=${c.createdAt.toISOString()}${tomb}`);
  }

  if (!yes) {
    const rl = createInterface({ input, output });
    const ans = (await rl.question('\nproceed? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('aborted');
      await sqlClient.end();
      return;
    }
  }

  // Distinct old hashes we're about to bind to this wallet.
  const distinctHashes = Array.from(new Set(candidates.map((c) => c.ownerHash)));

  await db.transaction(async (tx) => {
    await tx
      .update(functions)
      .set({ walletAddress, updatedAt: new Date() })
      .where(condition);

    for (const hash of distinctHashes) {
      await tx
        .insert(keyLinks)
        .values({ apiKeyHash: hash, walletAddress })
        .onConflictDoNothing({ target: keyLinks.apiKeyHash });
    }
  });

  // Confirmation count.
  const countRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(functions)
    .where(eq(functions.walletAddress, walletAddress));
  const total = countRows[0]?.count ?? 0;

  console.log(`done. ${candidates.length} function(s) claimed; total under ${walletAddress}: ${total}`);
  console.log(`wrote ${distinctHashes.length} key_link row(s).`);

  await sqlClient.end();
}

main().catch((err) => {
  console.error('claim-orphans failed:', err);
  sqlClient.end().finally(() => process.exit(1));
});
