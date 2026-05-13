// One-shot recovery: revive deployments that an older reconciler wrongly
// closed because outbound ingress probes from this server failed for 3
// consecutive ticks. For each "state='closed' AND error_message LIKE
// 'ingress unreachable%'", look the deployment up on-chain via the Console
// API; if the lease is still active, restore state='live' and clear
// closed_at + errorMessage.
//
// The auto-rehydrate pass in routes/functions.ts handles this on every
// /api/functions poll going forward. This script exists to unblock users
// before they reload the dashboard (or when the server hasn't been restarted
// with the fix yet).
//
// Usage:
//   AKASH_API_KEY=… npm run restore-closed-by-probe -w server [-- --dry-run] [--yes]
//
// Idempotent: re-running only restores rows whose lease is still on-chain.

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { and, eq, like } from 'drizzle-orm';
import { db, sqlClient } from '../src/db/client';
import { deployments } from '../src/db/schema';
import { ConsoleApiError, consoleApi } from '../src/akash/console-client';

const DRY_RUN = process.argv.includes('--dry-run');
const YES = process.argv.includes('--yes') || process.argv.includes('-y');

async function main(): Promise<void> {
  const apiKey = process.env.AKASH_API_KEY;
  if (!apiKey) {
    console.error('error: AKASH_API_KEY env var required');
    console.error('usage: AKASH_API_KEY=… npm run restore-closed-by-probe -w server [-- --dry-run] [--yes]');
    process.exit(2);
  }

  const candidates = await db
    .select({
      id: deployments.id,
      functionId: deployments.functionId,
      dseq: deployments.dseq,
      closedAt: deployments.closedAt,
      errorMessage: deployments.errorMessage,
    })
    .from(deployments)
    .where(and(
      eq(deployments.state, 'closed'),
      like(deployments.errorMessage, 'ingress unreachable%')
    ));

  if (candidates.length === 0) {
    console.log('no probe-closed deployments found — nothing to restore');
    await sqlClient.end();
    return;
  }

  console.log(`found ${candidates.length} probe-closed deployment(s):`);
  for (const c of candidates) {
    console.log(`  - ${c.id}  dseq=${c.dseq ?? '<none>'}  closed_at=${c.closedAt?.toISOString() ?? '<null>'}`);
  }

  if (!DRY_RUN && !YES) {
    const rl = createInterface({ input, output });
    const ans = (await rl.question('\ncross-check on-chain and restore those still active? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('aborted');
      await sqlClient.end();
      return;
    }
  }

  let restored = 0;
  let skippedReallyClosed = 0;
  let skippedNoDseq = 0;
  let errors = 0;

  for (const dep of candidates) {
    if (!dep.dseq) {
      skippedNoDseq += 1;
      console.log(`  skip ${dep.id}: no dseq on record`);
      continue;
    }
    try {
      const detail = await consoleApi.getDeployment(apiKey, dep.dseq);
      const deploymentClosed = detail.deployment?.state === 'closed';
      const allLeasesClosed =
        Array.isArray(detail.leases) &&
        detail.leases.length > 0 &&
        detail.leases.every((l) => l.state === 'closed');
      if (deploymentClosed || allLeasesClosed) {
        skippedReallyClosed += 1;
        console.log(`  skip ${dep.id} (dseq=${dep.dseq}): really closed on-chain`);
        continue;
      }
      if (!DRY_RUN) {
        await db
          .update(deployments)
          .set({ state: 'live', closedAt: null, errorMessage: null })
          .where(eq(deployments.id, dep.id));
      }
      restored += 1;
      console.log(`  ${DRY_RUN ? 'would RESTORE' : 'RESTORED'} ${dep.id} (dseq=${dep.dseq})`);
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 404) {
        skippedReallyClosed += 1;
        console.log(`  skip ${dep.id} (dseq=${dep.dseq}): 404 on-chain`);
        continue;
      }
      errors += 1;
      console.warn(`  err  ${dep.id} (dseq=${dep.dseq}): ${(err as Error).message}`);
    }
  }

  console.log(
    `\n${DRY_RUN ? 'DRY RUN' : 'APPLIED'}: restored=${restored} skipped_really_closed=${skippedReallyClosed} skipped_no_dseq=${skippedNoDseq} errors=${errors} candidates=${candidates.length}`
  );
}

main()
  .then(() => sqlClient.end())
  .catch(async (err) => {
    console.error('restore-closed-by-probe failed:', err);
    await sqlClient.end();
    process.exit(1);
  });
