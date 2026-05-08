// Deploy pipeline — fire-and-forget background worker.
//
// 1. Create deployment, capture dseq + manifest from Console API.
// 2. Poll bids until at least one shows up.
// 3. Submit the cheapest bid as a lease (the manifest goes to the provider here).
// 4. Poll the deployment until lease.status.services[serviceName].uris is set.
// 5. Mark live.

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { ConsoleApiError, consoleApi, type Lease } from './console-client';

export type StartDeployArgs = {
  apiKey: string;
  deploymentId: string;
  sdl: string;
  /** Service name in the SDL; used to extract URIs from lease status. */
  serviceName: string;
};

const BID_POLL_INTERVAL_MS = 2000;
const BID_POLL_TIMEOUT_MS = 60_000;
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = 180_000;

export function startDeployPipeline(args: StartDeployArgs): void {
  void runPipeline(args).catch((err) => {
    log.error('pipeline crashed', { err: String(err), deploymentId: args.deploymentId });
  });
}

async function runPipeline({
  apiKey,
  deploymentId,
  sdl,
  serviceName,
}: StartDeployArgs): Promise<void> {
  const setState = async (
    state: string,
    extra: Partial<typeof deployments.$inferInsert> = {}
  ) => {
    await db.update(deployments).set({ state, ...extra }).where(eq(deployments.id, deploymentId));
  };

  try {
    // 1. Create deployment.
    const created = await consoleApi.createDeployment(apiKey, {
      sdl,
      deposit: env.DEPLOY_DEPOSIT,
    });
    const { dseq, manifest } = created;
    await setState('bidding', { dseq });
    log.info('deployment created', { deploymentId, dseq, txHash: created.signTx.transactionHash });

    // 2. Poll bids.
    const bid = await pollUntil({
      label: 'bids',
      intervalMs: BID_POLL_INTERVAL_MS,
      timeoutMs: BID_POLL_TIMEOUT_MS,
      fn: async () => {
        const bids = await consoleApi.getBids(apiKey, dseq);
        const open = bids.filter((b) => b.state === 'open' || b.state === 'active');
        if (!open.length) return undefined;
        return open
          .slice()
          .sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
      },
    });
    log.info('bid selected', { deploymentId, provider: bid.id.provider, price: bid.price });

    // 3. Accept lease — this is the step that pushes the manifest to the
    //    provider, who then schedules our pod.
    const leaseResp = await consoleApi.acceptLeases(apiKey, {
      manifest,
      leases: [
        {
          dseq,
          gseq: bid.id.gseq,
          oseq: bid.id.oseq,
          provider: bid.id.provider,
        },
      ],
    });
    const ourLease = leaseResp.leases[0];
    if (!ourLease) throw new Error('lease accept returned no leases');
    await setState('leased', {
      provider: ourLease.id.provider,
      gseq: ourLease.id.gseq,
      oseq: ourLease.id.oseq,
    });
    log.info('lease accepted', { deploymentId, provider: ourLease.id.provider });

    // 4. Poll deployment status for service URIs.
    const uris = await pollUntil({
      label: 'service-uris',
      intervalMs: STATUS_POLL_INTERVAL_MS,
      timeoutMs: STATUS_POLL_TIMEOUT_MS,
      fn: async () => {
        const detail = await consoleApi.getDeployment(apiKey, dseq);
        const lease = pickLease(detail.leases, ourLease);
        const svc = lease?.status?.services?.[serviceName];
        if (svc?.uris && svc.uris.length > 0) return svc.uris;
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

function pickLease(leases: Lease[], target: Lease): Lease | undefined {
  return leases.find(
    (l) =>
      l.id.gseq === target.id.gseq &&
      l.id.oseq === target.id.oseq &&
      l.id.provider === target.id.provider
  );
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
