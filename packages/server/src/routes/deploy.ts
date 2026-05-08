// /api/functions/:id/deploy — kick off the Akash deploy pipeline.
// Returns immediately with the deployment row; the pipeline runs in the
// background and updates the row's state.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { DeploymentRecord } from '@shared/types';
import { startDeployPipeline } from '../akash/pipeline';
import { buildSdl } from '../akash/sdl';
import { db } from '../db/client';
import { deployments, functionVersions, functions } from '../db/schema';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { signCode } from '../lib/signing';

const Body = z.object({
  versionId: z.string().uuid().optional(),
  akashmlKey: z.string().optional(),
});

export const deployRouter = new Hono<{ Variables: AuthVars }>();

deployRouter.use('*', requireAkashKey);

deployRouter.post('/:id/deploy', zValidator('json', Body), async (c) => {
  const ownerHash = c.get('ownerHash');
  const akashKey = c.get('akashKey');
  const fnId = c.req.param('id');
  const body = c.req.valid('json');

  // Confirm ownership.
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.ownerHash, ownerHash), isNull(functions.deletedAt)))
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

  // Build SDL with a short-lived HMAC token for the runner's code-fetch.
  const codeToken = signCode({ fnId: fn.id, versionId: version.id });
  const sdl = buildSdl({
    functionId: fn.id,
    versionId: version.id,
    codeToken,
    resources: version.resources,
    akashmlKey: body.akashmlKey ?? version.envVars['AKASHML_API_KEY'],
  });

  // Fire-and-forget the pipeline. The frontend polls /:id/deployments/:depId.
  startDeployPipeline({ bearerToken: akashKey, deploymentId: dep.id, sdl });

  return c.json(toRecord(dep), 202);
});

deployRouter.get('/:id/deployments/:depId', async (c) => {
  const ownerHash = c.get('ownerHash');
  const fnId = c.req.param('id');
  const depId = c.req.param('depId');

  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, fnId), eq(functions.ownerHash, ownerHash)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const [dep] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, depId), eq(deployments.functionId, fnId)))
    .limit(1);
  if (!dep) throw new HTTPException(404, { message: 'Deployment not found' });

  return c.json(toRecord(dep));
});

function toRecord(dep: typeof deployments.$inferSelect): DeploymentRecord {
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
    createdAt: dep.createdAt.toISOString(),
    liveAt: dep.liveAt?.toISOString(),
    closedAt: dep.closedAt?.toISOString(),
  };
}
