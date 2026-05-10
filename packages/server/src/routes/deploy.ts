// /api/functions/:id/deploy — kick off the Akash deploy pipeline.
// Returns immediately with the deployment row; the pipeline runs in the
// background and updates the row's state.

import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { DeploymentRecord, FunctionRoute } from '@shared/types';
import { consoleApi } from '../akash/console-client';
import { startDeployPipeline } from '../akash/pipeline';
import { buildSdl } from '../akash/sdl';
import { db } from '../db/client';
import { deployments, functionVersions, functions } from '../db/schema';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { signRunner } from '../lib/signing';
import { log } from '../lib/log';
import { extractRoutes } from './extract-routes';

const Body = z.object({
  versionId: z.string().uuid().optional(),
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

  // Persist deployment row first so the frontend has something to poll.
  const [dep] = await db
    .insert(deployments)
    .values({
      functionId: fn.id,
      versionId: version.id,
      state: 'pending',
    })
    .returning();
  if (!dep) throw new HTTPException(500, { message: 'Failed to record deployment' });

  // Build SDL with a long-lived runner token. The runner uses it both for the
  // first code fetch and for the poll loop that picks up new versions. User
  // env vars (including AKASHML_API_KEY) flow through /api/runner/env, not
  // the SDL — the SDL is semi-public (providers see it) and unsuitable for
  // secrets.
  const runnerToken = signRunner({ fnId: fn.id });
  const sdl = await buildSdl({
    functionId: fn.id,
    initialVersionId: version.id,
    runnerToken,
    resources: version.resources,
  });

  // Fire-and-forget the pipeline. The frontend polls /:id/deployments/:depId.
  // serviceName must match the SDL's `services.<name>` key — we use 'fn'.
  startDeployPipeline({ apiKey: akashKey, deploymentId: dep.id, sdl, serviceName: 'fn' });

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

  const [version] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.id, dep.versionId))
    .limit(1);
  if (!version) {
    throw new HTTPException(500, { message: 'Version row missing for deployment' });
  }

  // Fresh runner token + fresh resolveRunnerImage() pick up the new :latest tag.
  // The previous token stays valid until expiry, so any in-flight runner→server
  // calls during the container swap won't 401.
  const runnerToken = signRunner({ fnId });
  const sdl = await buildSdl({
    functionId: fnId,
    initialVersionId: dep.versionId,
    runnerToken,
    resources: version.resources,
  });

  await consoleApi.updateDeployment(akashKey, dep.dseq, sdl);
  log.info('runner image update submitted', {
    fnId,
    depId,
    dseq: dep.dseq,
    versionId: dep.versionId,
  });

  // Optimistically clear errorMessage. The new container's health probe will
  // re-write it if the new image breaks anything; otherwise the old text would
  // sit there during the restart window even though it no longer applies.
  await db.update(deployments).set({ errorMessage: null }).where(eq(deployments.id, dep.id));

  return c.json(toRecord({ ...dep, errorMessage: null }), 202);
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

  // Routes are derived from the version's source on every fetch. Parsing here
  // (rather than at write time) means edits propagate as soon as a new version
  // is created — no schema change, no migration, no runner round-trip.
  const [version] = await db
    .select({ source: functionVersions.source })
    .from(functionVersions)
    .where(eq(functionVersions.id, dep.versionId))
    .limit(1);
  const routes = version ? extractRoutes(version.source) : undefined;

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
    createdAt: dep.createdAt.toISOString(),
    liveAt: dep.liveAt?.toISOString(),
    closedAt: dep.closedAt?.toISOString(),
  };
}

