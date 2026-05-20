// Deploy pipeline — fire-and-forget background worker.
//
// 1. Create deployment, capture dseq + manifest from Console API.
// 2. Poll bids until at least one shows up.
// 3. Submit the cheapest bid as a lease (the manifest goes to the provider here).
// 4. Poll the deployment until lease.status.services[serviceName].uris is set.
// 5. Mark live.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments } from '../db/schema';
import { env } from '../env';
import { log } from '../lib/log';
import { ConsoleApiError, consoleApi, type Bid, type Lease } from './console-client';
import { getBlocklistedProviders, recordProviderFailure } from './provider-health';
import { isRunnerFresh, probeIngress, RUNNER_HEALTH_PATH, toFetchUrl } from './reconciler';

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

    // 2. Poll bids. Exclude providers currently in the smoke-probe cooldown
    //    window (provider_health.cooldown_until > now). If every open bid is
    //    from a blocklisted provider, fall back to the cheapest one and stamp
    //    a warning on the row — the user is staring at a deploy spinner and a
    //    hard fail is worse UX than letting them retry on a known-flaky
    //    provider.
    const { bid, usedFallback } = await pollUntil({
      label: 'bids',
      intervalMs: BID_POLL_INTERVAL_MS,
      timeoutMs: BID_POLL_TIMEOUT_MS,
      fn: async () => {
        const bids = await consoleApi.getBids(apiKey, dseq);
        const open = bids.filter((b) => b.state === 'open' || b.state === 'active');
        if (!open.length) return undefined;
        const blocklisted = await getBlocklistedProviders();
        const eligible = open.filter((b) => !blocklisted.has(b.id.provider));
        const byPrice = (a: Bid, b: Bid) => Number(a.price.amount) - Number(b.price.amount);
        if (eligible.length > 0) {
          return { bid: eligible.slice().sort(byPrice)[0]!, usedFallback: false };
        }
        return { bid: open.slice().sort(byPrice)[0]!, usedFallback: true };
      },
    });
    if (usedFallback) {
      log.warn('all candidate providers in cooldown; using cheapest available anyway', {
        deploymentId,
        provider: bid.id.provider,
      });
      await setState('bidding', {
        errorMessage: 'all candidate providers in cooldown; using cheapest available anyway',
      });
    }
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

    // Eager smoke probe: don't wait up to a full reconciler tick to learn
    // whether the provider's ingress is actually serving paths. The runner
    // typically heartbeats within ~10-15s of container boot, and Akash only
    // flips uris after the provider's ingress is up — by T+10s the probe
    // should be conclusive for any healthy provider. For broken providers
    // (gcnlab.fyi pattern), this collapses the "Provider's ingress isn't
    // routing requests" surface time from minutes to seconds.
    void scheduleEagerProbe(deploymentId, ourLease.id.provider, uris[0]).catch((err) =>
      log.warn('eager smoke probe failed to schedule', { deploymentId, err: String(err) })
    );
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

const EAGER_PROBE_DELAY_MS = 10_000;
const EAGER_PROBE_TIMEOUT_MS = 5_000;

// Eager smoke probe — runs once after the pipeline marks a deployment live,
// so we don't have to wait up to a full reconciler tick (60s) before learning
// the provider's inbound path is broken. The reconciler still owns ongoing
// health on the deployment; this just collapses the first-detection latency.
//
// Only attributes failure to the provider when the runner heartbeat is
// already fresh — that confirms the runner booted and is ready to answer,
// so a failed probe is unambiguously the inbound path's fault. If the
// heartbeat hasn't fired yet, the runner may still be initializing and the
// regular reconciler logic (with its 3-strike runner-stale path) will pick
// up the slack.
async function scheduleEagerProbe(
  deploymentId: string,
  provider: string,
  url: string | undefined
): Promise<void> {
  if (!url || !provider) return;

  // Give the runner a beat to boot. Akash flips uris when the lease is
  // exposed, but the user code + runner inside may still be initializing.
  await sleep(EAGER_PROBE_DELAY_MS);

  const reachable = await probeIngress(toFetchUrl(url), EAGER_PROBE_TIMEOUT_MS, {
    path: RUNNER_HEALTH_PATH,
    requireStatus: 200,
  });
  if (reachable) {
    log.info('eager smoke probe ok', { deploymentId, url });
    return;
  }

  const [row] = await db
    .select({ runnerSeenAt: deployments.runnerSeenAt, state: deployments.state })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row || row.state !== 'live') return;
  if (!isRunnerFresh(row.runnerSeenAt)) {
    log.warn('eager smoke probe failed but runner not yet heartbeating; deferring to reconciler', {
      deploymentId,
      url,
    });
    return;
  }

  log.warn('eager smoke probe failed with runner fresh; flagging provider', {
    deploymentId,
    url,
    provider,
  });

  void recordProviderFailure(provider, 'eager smoke probe failed; runner heartbeat fresh').catch(
    (err) => log.error('recordProviderFailure failed', { provider, err: String(err) })
  );

  await db
    .update(deployments)
    .set({
      errorMessage:
        'function routes unreachable through this provider — redeploy to retry on a healthier one',
    })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.state, 'live')));
}
