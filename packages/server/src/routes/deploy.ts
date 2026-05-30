// /api/functions/:id/deploy — kick off the Akash deploy pipeline.
// Returns immediately with the deployment row; the pipeline runs in the
// background and updates the row's state.

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { DeploymentRecord, FunctionRoute } from '@shared/types';
import { startDeployPipeline } from '../akash/pipeline';
import { cacheWalletKey } from '../akash/key-cache';
import { clampMaxWaitMs } from '../akash/wait-policy';
import { waitPolicyConfig } from '../akash/waiting-driver';
import { isRunnerFresh, probeIngress, toFetchUrl } from '../akash/reconciler';
import { rebuildAndUpdateSdl } from '../akash/rebind';
import { buildSdl } from '../akash/sdl';
import { db } from '../db/client';
import { deployments, functionVersions, functions } from '../db/schema';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { EXPECTED_RUNNER_VERSION, isRunnerOutdated, isRunnerStale } from '../lib/runner-version';
import { signRunner } from '../lib/signing';
import { readSource } from '../lib/source';
import { extractRoutes } from './extract-routes';

const Body = z.object({
  versionId: z.string().uuid().optional(),
  // Wait-for-capacity opt-in (default OFF). maxWaitMs is clamped server-side.
  waitForCapacity: z.boolean().optional(),
  maxWaitMs: z.number().int().positive().optional(),
});

export const deployRouter = new Hono<{ Variables: AuthVars }>();

deployRouter.use('*', requireAkashKey);

deployRouter.post('/:id/deploy', zValidator('json', Body), async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const fnId = c.req.param('id');
  const body = c.req.valid('json');

  // Confirm ownership.
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  // Resolve version (explicit or latest).
  const version = body.versionId
    ? (
        await db
          .select()
          .from(functionVersions)
          .where(and(eq(functionVersions.id, body.versionId), eq(functionVersions.functionId, fnId)))
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(functionVersions)
          .where(eq(functionVersions.functionId, fnId))
          .orderBy(desc(functionVersions.createdAt))
          .limit(1)
      )[0];

  if (!version) throw new HTTPException(400, { message: 'No code version to deploy' });

  // 1 function = 1 deployment. If a non-closed deployment already exists,
  // refuse — the user must close it via settings (or clone the function) before
  // attempting another deploy.
  const [existing] = await db
    .select({ id: deployments.id, state: deployments.state })
    .from(deployments)
    .where(
      and(
        eq(deployments.functionId, fn.id),
        notInArray(deployments.state, ['closed', 'failed'])
      )
    )
    .limit(1);
  if (existing) {
    throw new HTTPException(409, {
      message: `Function already has an active deployment (state=${existing.state}). Close it from settings, or clone the function to deploy a new copy.`,
    });
  }

  // Build SDL before inserting the deployment row — buildSdl resolves the
  // runner image against GitHub releases and can throw on rate-limit hiccups.
  // Inserting first would leave an orphan 'pending' row that the 409 check
  // above then rejects on the user's retry. User env vars (e.g.
  // AKASHML_API_KEY) flow through /api/runner/env, not the SDL — the SDL is
  // semi-public (providers see it) and unsuitable for secrets.
  const runnerToken = signRunner({ fnId: fn.id });
  const sdl = await buildSdl({
    functionId: fn.id,
    initialVersionId: version.id,
    runnerToken,
    resources: version.resources,
  });

  const waitForCapacity = body.waitForCapacity ?? false;

  // Persist deployment row so the frontend has something to poll.
  const [dep] = await db
    .insert(deployments)
    .values({
      functionId: fn.id,
      versionId: version.id,
      state: 'pending',
      waitForCapacity,
      maxWaitMs: waitForCapacity ? clampMaxWaitMs(body.maxWaitMs, waitPolicyConfig()) : null,
    })
    .returning();
  if (!dep) throw new HTTPException(500, { message: 'Failed to record deployment' });

  // Cache the Console key (encrypted) ONLY for delayed-start services — the
  // reconciler's retry bursts need it. A fail-fast service never waits, so we
  // don't broaden credential-at-rest exposure (D1 threat model). Jobs cache
  // unconditionally (teardown needs it); a plain service deploy does not.
  if (waitForCapacity) {
    await cacheWalletKey(walletAddress, akashKey);
  }

  // Fire-and-forget the pipeline. The frontend polls /:id/deployments/:depId.
  // serviceName must match the SDL's `services.<name>` key — we use 'fn'.
  startDeployPipeline({ apiKey: akashKey, deploymentId: dep.id, sdl, serviceName: 'fn', waitForCapacity });

  return c.json(toRecord(dep), 202);
});

// In-place runner image update. Akash's MsgUpdateDeployment lets us submit a
// fresh SDL on the same dseq — the provider re-pulls and restarts the container
// while keeping the lease, gseq, oseq, and uris intact. Used to roll out a new
// runner image (e.g. supervisor changes) to existing live deployments without
// charging the user for a fresh bid.
deployRouter.post('/:id/deployments/:depId/update-image', async (c) => {
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const fnId = c.req.param('id');
  const depId = c.req.param('depId');

  const [fn] = await db
    .select()
    .from(functions)
    .where(
      and(
        eq(functions.id, fnId),
        eq(functions.walletAddress, walletAddress),
        isNull(functions.deletedAt)
      )
    )
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const [dep] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, depId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Deployment not found' });
  if (dep.state !== 'live' || !dep.dseq) {
    throw new HTTPException(409, {
      message: `Deployment is ${dep.state}; only live deployments can be updated`,
    });
  }

  const result = await rebuildAndUpdateSdl({ akashKey, fnId, dep, reason: 'manual' });
  if (!result.ok) {
    throw new HTTPException(result.status as 409 | 500, { message: result.message });
  }
  return c.json(toRecord(result.deployment), 202);
});

// Real ingress reachability. Akash flips state to 'live' when the manifest is
// accepted, but the provider's nginx still 503s for ~10-30s while the upstream
// container boots — and for slow-booting user code (e.g. an LLM loading a
// model) that window can stretch to 60s+. The browser can't tell 503 from 200
// in `no-cors` mode, so we probe server-side and expose a boolean. Frontend
// polls this until true before showing the URL as ready.
//
// Cross-check the probe against runnerSeenAt the same way the reconciler does
// (see akash/reconciler.ts): the runner is the better signal because it lives
// inside the deployment and only stops polling when the lease is actually
// gone. If the probe fails but the runner has reported within RUNNER_FRESH_MS,
// treat the ingress as reachable — otherwise a flaky cross-provider HTTP path
// or a slow first response leaves the UI stuck on "Finalizing your endpoint"
// even though end-user traffic is already flowing.
deployRouter.get('/:id/ingress-reachable', async (c) => {
  const walletAddress = c.get('walletAddress');
  const fnId = c.req.param('id');

  const [fn] = await db
    .select({ id: functions.id })
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.walletAddress, walletAddress)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const [dep] = await db
    .select({
      state: deployments.state,
      uris: deployments.uris,
      runnerSeenAt: deployments.runnerSeenAt,
    })
    .from(deployments)
    .where(and(eq(deployments.functionId, fnId), eq(deployments.state, 'live')))
    .orderBy(desc(deployments.createdAt))
    .limit(1);

  const uri = dep?.uris?.[0];
  if (!uri) return c.json({ reachable: false });

  if (await probeIngress(toFetchUrl(uri))) {
    return c.json({ reachable: true });
  }

  return c.json({ reachable: isRunnerFresh(dep?.runnerSeenAt ?? null) });
});

deployRouter.get('/:id/deployments/:depId', async (c) => {
  const walletAddress = c.get('walletAddress');
  const fnId = c.req.param('id');
  const depId = c.req.param('depId');

  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.walletAddress, walletAddress)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const [dep] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, depId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Deployment not found' });

  // Routes are derived from the latest version's source on every fetch.
  // Parsing here (rather than at write time) means edits propagate as soon as
  // a new version is created — no schema change, no migration, no runner
  // round-trip. We read the latest version by functionId (mirroring the
  // runner's `/current/:fnId` query) rather than dep.versionId, because the
  // latter is set once at deploy time and only catches up once the runner
  // reports back via /health — which would leave the dashboard showing stale
  // routes for the ~10s between save and runner reload.
  const [version] = await db
    .select({
      sourceCiphertext: functionVersions.sourceCiphertext,
      sourceIv: functionVersions.sourceIv,
      sourceAuthTag: functionVersions.sourceAuthTag,
      sourceKeyVersion: functionVersions.sourceKeyVersion,
    })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, fnId))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);
  const detected = version ? extractRoutes(readSource(version)) : undefined;
  const routes = detected
    ? decorateRoutesWithAuth(detected, fn.protectedRoutes)
    : undefined;

  return c.json(toRecord(dep, routes));
});

function toRecord(
  dep: typeof deployments.$inferSelect,
  routes?: FunctionRoute[]
): DeploymentRecord {
  return {
    id: dep.id,
    functionId: dep.functionId,
    versionId: dep.versionId,
    state: dep.state as DeploymentRecord['state'],
    dseq: dep.dseq ?? undefined,
    gseq: dep.gseq ?? undefined,
    oseq: dep.oseq ?? undefined,
    provider: dep.provider ?? undefined,
    uris: dep.uris ?? undefined,
    errorMessage: dep.errorMessage ?? undefined,
    routes,
    runnerVersion: dep.runnerVersion ?? undefined,
    runnerSeenAt: dep.runnerSeenAt?.toISOString(),
    expectedRunnerVersion: EXPECTED_RUNNER_VERSION,
    runnerOutdated: isRunnerOutdated(dep.runnerVersion, dep.liveAt),
    runnerStale: isRunnerStale(dep.runnerSeenAt, dep.liveAt, dep.state),
    waitingSince: dep.waitingSince?.toISOString(),
    maxWaitMs: dep.maxWaitMs ?? undefined,
    createdAt: dep.createdAt.toISOString(),
    liveAt: dep.liveAt?.toISOString(),
    closedAt: dep.closedAt?.toISOString(),
  };
}

// Fallback when the extractor finds no routes in user code (e.g. raw
// Bun.serve handlers). Exposing a single GET / lets the UI render the routes
// panel and the user toggle Protected on the root URL; the runner receives
// the same fallback so the toggle enforces end-to-end.
export const FALLBACK_ROUTES: FunctionRoute[] = [{ method: 'GET', path: '/' }];

// Stamps each detected route with `auth: 'public' | 'apiKey'` based on the
// function's protected-routes set. The set holds `"<METHOD> <path>"` keys so
// callers can compare without a second pass.
export function decorateRoutesWithAuth(
  routes: FunctionRoute[],
  protectedRoutes: string[]
): FunctionRoute[] {
  if (protectedRoutes.length === 0) {
    return routes.map((r) => ({ ...r, auth: 'public' as const }));
  }
  const set = new Set(protectedRoutes);
  return routes.map((r) => ({
    ...r,
    auth: set.has(routeKey(r.method, r.path)) ? ('apiKey' as const) : ('public' as const),
  }));
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

