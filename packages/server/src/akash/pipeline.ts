// Deploy pipeline — fire-and-forget background worker.
//
// 1. Validate SDL (best effort).
// 2. Create deployment, store dseq.
// 3. Poll bids until at least one shows up.
// 4. Accept the cheapest.
// 5. Poll lease status until the service URIs land.
// 6. Mark live.

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { ConsoleApiError, consoleApi } from './console-client';

export type StartDeployArgs = {
  bearerToken: string;
  deploymentId: string;
  sdl: string;
};

const BID_POLL_INTERVAL_MS = 2000;
const BID_POLL_TIMEOUT_MS = 60_000;
const STATUS_POLL_INTERVAL_MS = 2000;
const STATUS_POLL_TIMEOUT_MS = 120_000;

export function startDeployPipeline(args: StartDeployArgs): void {
  // Run async, swallow rejections — state is persisted to deployments row.
  void runPipeline(args).catch((err) => {
    log.error('pipeline crashed', { err: String(err), deploymentId: args.deploymentId });
  });
}

async function runPipeline({ bearerToken, deploymentId, sdl }: StartDeployArgs): Promise<void> {
  const setState = async (
    state: string,
    extra: Partial<typeof deployments.$inferInsert> = {}
  ) => {
    await db.update(deployments).set({ state, ...extra }).where(eq(deployments.id, deploymentId));
  };

  try {
    // 1. Optional pre-flight validate. We swallow validation errors and let
    //    createDeployment fail authoritatively, but log them.
    try {
      const validation = await consoleApi.validateSdl(bearerToken, sdl);
      if (!validation.valid) {
        log.warn('sdl validation reported invalid', { deploymentId });
      }
    } catch (err) {
      log.warn('sdl validation failed', { deploymentId, err: String(err) });
    }

    // 2. Create deployment.
    const created = await consoleApi.createDeployment(bearerToken, {
      sdl,
      deposit: env.DEPLOY_DEPOSIT,
    });
    const dseq = created.dseq;
    await setState('bidding', { dseq });
    log.info('deployment created', { deploymentId, dseq });

    // 3. Poll bids.
    const bid = await pollUntil({
      label: 'bids',
      intervalMs: BID_POLL_INTERVAL_MS,
      timeoutMs: BID_POLL_TIMEOUT_MS,
      fn: async () => {
        const bids = await consoleApi.getBids(bearerToken, dseq);
        if (!bids.length) return undefined;
        // Lowest price first.
        return bids
          .slice()
          .sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
      },
    });

    // 4. Accept lease.
    const lease = await consoleApi.acceptLease(bearerToken, {
      dseq,
      gseq: 1,
      oseq: 1,
      provider: bid.provider,
    });
    await setState('leased', { provider: lease.provider, gseq: lease.gseq, oseq: lease.oseq });
    log.info('lease accepted', { deploymentId, provider: lease.provider });

    // 5. Poll status for URIs.
    const uris = await pollUntil({
      label: 'lease-status',
      intervalMs: STATUS_POLL_INTERVAL_MS,
      timeoutMs: STATUS_POLL_TIMEOUT_MS,
      fn: async () => {
        const status = await consoleApi.getLeaseStatus(bearerToken, dseq, 1, 1);
        const fn = status.services?.fn;
        if (fn?.uris && fn.uris.length > 0) return fn.uris;
        return undefined;
      },
    });

    await setState('live', { uris, liveAt: new Date() });
    log.info('deployment live', { deploymentId, uris });
  } catch (err) {
    const message =
      err instanceof ConsoleApiError ? `${err.code}: ${err.message}` : String(err);
    log.error('pipeline failed', { deploymentId, err: message });
    await setState('failed', { errorMessage: message }).catch(() => undefined);
  }
}

async function pollUntil<T>({
  label,
  intervalMs,
  timeoutMs,
  fn,
}: {
  label: string;
  intervalMs: number;
  timeoutMs: number;
  fn: () => Promise<T | undefined>;
}): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await fn();
      if (out !== undefined) return out;
    } catch (err) {
      log.warn(`poll ${label} failed`, { err: String(err) });
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
