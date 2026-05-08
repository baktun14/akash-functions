// /api/functions — CRUD for function records and their version history.

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type {
  FunctionRecord,
  FunctionVersionDetail,
  FunctionVersionSummary,
  PresetId,
} from '@shared/types';
import { consoleApi } from '../akash/console-client';
import { startDeployPipeline } from '../akash/pipeline';
import { buildSdl } from '../akash/sdl';
import { db } from '../db/client';
import { deployments, functionVersions, functions } from '../db/schema';
import { env } from '../env';
import { signRunner } from '../lib/signing';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

const ResourceSchema = z.object({
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
});

// Per-file 1MB cap, plus total-size cap of 5MB to keep JSONB rows reasonable.
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 5_000_000;
const SourceMapSchema = z
  .record(z.string(), z.string().max(MAX_FILE_BYTES, 'file too large (max 1MB)'))
  .refine(
    (m) => Object.values(m).reduce((n, s) => n + s.length, 0) <= MAX_TOTAL_BYTES,
    { message: 'source map too large (max 5MB total)' }
  );

const CreateBody = z.object({
  name: z.string().min(1).max(60),
  preset: z.enum(['rest', 'jsx', 'cron', 'gpu']),
  prompt: z.string().optional(),
  source: SourceMapSchema,
  resources: ResourceSchema,
  envVars: z.record(z.string(), z.string()).optional(),
});

const UpdateNameBody = z.object({ name: z.string().min(1).max(60) });

const UpdateCodeBody = z.object({
  source: SourceMapSchema,
  message: z.string().max(200).optional(),
  resources: ResourceSchema.optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});

const RestoreBody = z.object({
  message: z.string().max(200).optional(),
});

export const functionsRouter = new Hono<{ Variables: AuthVars }>();

functionsRouter.use('*', requireAkashKey);

functionsRouter.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const rows = await db
    .select()
    .from(functions)
    .where(and(eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .orderBy(desc(functions.createdAt));

  // Decorate with the latest deployment URI so the frontend can show it
  // straight away in the cards list.
  const list: FunctionRecord[] = await Promise.all(
    rows.map(async (fn) => {
      const dep = await latestDeployment(fn.id);
      return {
        id: fn.id,
        name: fn.name,
        kind: 'function' as const,
        subdomain: dep?.uris?.[0] ?? `${fn.subdomain}.akash-functions.io`,
        image: env.RUNNER_IMAGE,
        status: dep ? stateToStatus(dep.state) : 'idle',
        latestDeploymentId: dep?.id,
      };
    })
  );

  return c.json(list);
});

functionsRouter.post('/', zValidator('json', CreateBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const walletAddress = c.get('walletAddress');
  const body = c.req.valid('json');
  const subdomain = mintSubdomain(body.name);

  const inserted = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
        walletAddress,
        name: body.name,
        subdomain,
      })
      .returning();
    if (!fn) throw new HTTPException(500, { message: 'Failed to insert function' });

    await tx.insert(functionVersions).values({
      functionId: fn.id,
      preset: body.preset,
      prompt: body.prompt ?? null,
      source: body.source,
      resources: body.resources,
      envVars: body.envVars ?? {},
    });

    return fn;
  });

  return c.json(toRecord(inserted), 201);
});

functionsRouter.get('/:id', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);
  return c.json(toRecord(fn));
});

functionsRouter.put('/:id', zValidator('json', UpdateNameBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);
  const [updated] = await db
    .update(functions)
    .set({ name: c.req.valid('json').name, updatedAt: new Date() })
    .where(eq(functions.id, id))
    .returning();
  if (!updated) throw new HTTPException(500, { message: 'Update failed' });
  return c.json(toRecord(updated));
});

functionsRouter.put('/:id/code', zValidator('json', UpdateCodeBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);
  const body = c.req.valid('json');

  // Need an existing version to copy unset fields from.
  const [latest] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);

  const [version] = await db
    .insert(functionVersions)
    .values({
      functionId: id,
      preset: latest?.preset ?? 'rest',
      prompt: latest?.prompt ?? null,
      message: body.message ?? null,
      source: body.source,
      resources: body.resources ?? latest?.resources ?? { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
      envVars: body.envVars ?? latest?.envVars ?? {},
    })
    .returning();
  if (!version) throw new HTTPException(500, { message: 'Insert failed' });
  return c.json(
    { id: version.id, createdAt: version.createdAt.toISOString(), message: version.message },
    201
  );
});

// GET /:id/versions — list every version of a function (most recent first).
// Returns lightweight summaries; use GET /:id/versions/:versionId for source.
functionsRouter.get('/:id/versions', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  await getFn(walletAddress, id);

  const rows = await db
    .select({
      id: functionVersions.id,
      createdAt: functionVersions.createdAt,
      message: functionVersions.message,
      preset: functionVersions.preset,
      deploymentCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${deployments}
        WHERE ${deployments.versionId} = ${functionVersions.id}
      )`,
    })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(100);

  const list: FunctionVersionSummary[] = rows.map((r, i) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    message: r.message,
    preset: r.preset as PresetId,
    isLatest: i === 0,
    deploymentCount: r.deploymentCount,
  }));

  return c.json(list);
});

// GET /:id/versions/:versionId — full detail for a single version (source + config).
functionsRouter.get('/:id/versions/:versionId', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  await getFn(walletAddress, id);

  const [v] = await db
    .select()
    .from(functionVersions)
    .where(and(eq(functionVersions.id, versionId), eq(functionVersions.functionId, id)))
    .limit(1);
  if (!v) throw new HTTPException(404, { message: 'Version not found' });

  const [latest] = await db
    .select({ id: functionVersions.id })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);

  const countRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(deployments)
    .where(eq(deployments.versionId, v.id));
  const count = countRows[0]?.count ?? 0;

  const detail: FunctionVersionDetail = {
    id: v.id,
    createdAt: v.createdAt.toISOString(),
    message: v.message,
    preset: v.preset as PresetId,
    isLatest: latest?.id === v.id,
    deploymentCount: count,
    source: v.source,
    resources: v.resources,
    envVars: v.envVars,
  };
  return c.json(detail);
});

// POST /:id/versions/:versionId/restore — copy an old version forward as a new
// version. Never destructive; the resulting version becomes the latest.
// Does NOT trigger a deploy on its own.
functionsRouter.post('/:id/versions/:versionId/restore', zValidator('json', RestoreBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const versionId = c.req.param('versionId');
  await getFn(walletAddress, id);
  const body = c.req.valid('json');

  const [target] = await db
    .select()
    .from(functionVersions)
    .where(and(eq(functionVersions.id, versionId), eq(functionVersions.functionId, id)))
    .limit(1);
  if (!target) throw new HTTPException(404, { message: 'Version not found' });

  const defaultMessage = `Restored from ${target.id.slice(0, 7)} @ ${target.createdAt.toISOString()}`;

  const [created] = await db
    .insert(functionVersions)
    .values({
      functionId: id,
      preset: target.preset,
      prompt: target.prompt,
      message: body.message ?? defaultMessage,
      source: target.source,
      resources: target.resources,
      envVars: target.envVars,
    })
    .returning();
  if (!created) throw new HTTPException(500, { message: 'Insert failed' });

  return c.json(
    { id: created.id, createdAt: created.createdAt.toISOString(), message: created.message },
    201
  );
});

// POST /:id/clone — create a new function from an existing one's latest version
// and fire its deploy pipeline. Used by "Redeploy" since 1 function = 1
// deployment; you can't reuse the original record once it's been deployed.
functionsRouter.post('/:id/clone', async (c) => {
  const ownerHash = c.get('ownerHash');
  const walletAddress = c.get('walletAddress');
  const akashKey = c.get('akashKey');
  const id = c.req.param('id');
  const source = await getFn(walletAddress, id);

  // Latest version provides source/resources/envVars/preset.
  const [latest] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.functionId, id))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);
  if (!latest) throw new HTTPException(400, { message: 'Source function has no code version' });

  // Insert function + version + pending deployment in one transaction.
  const { fn, version, dep } = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
        walletAddress,
        name: source.name,
        subdomain: mintSubdomain(source.name),
      })
      .returning();
    if (!fn) throw new HTTPException(500, { message: 'Failed to insert cloned function' });

    const [version] = await tx
      .insert(functionVersions)
      .values({
        functionId: fn.id,
        preset: latest.preset,
        prompt: latest.prompt,
        source: latest.source,
        resources: latest.resources,
        envVars: latest.envVars,
      })
      .returning();
    if (!version) throw new HTTPException(500, { message: 'Failed to insert cloned version' });

    const [dep] = await tx
      .insert(deployments)
      .values({
        functionId: fn.id,
        versionId: version.id,
        state: 'pending',
      })
      .returning();
    if (!dep) throw new HTTPException(500, { message: 'Failed to insert deployment' });

    return { fn, version, dep };
  });

  // Build SDL + fire pipeline (same shape as POST /:id/deploy).
  const runnerToken = signRunner({ fnId: fn.id });
  const sdl = buildSdl({
    functionId: fn.id,
    initialVersionId: version.id,
    runnerToken,
    resources: version.resources,
    akashmlKey: version.envVars['AKASHML_API_KEY'],
  });
  startDeployPipeline({ apiKey: akashKey, deploymentId: dep.id, sdl, serviceName: 'fn' });

  return c.json(
    {
      ...toRecord(fn),
      deploymentId: dep.id,
      latestDeploymentId: dep.id,
    },
    201
  );
});

// POST /:id/close-deployment — close the active Akash lease without
// tombstoning the function. Used by the migration flow (close 1.x pod →
// Save & Deploy boots a 2.x pod with hot-reload). The function record and
// version history stay; the user can redeploy whenever.
functionsRouter.post('/:id/close-deployment', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);

  const dep = await latestDeployment(fn.id);
  if (!dep || dep.state === 'closed' || dep.state === 'failed') {
    throw new HTTPException(409, {
      message: 'No active deployment to close',
    });
  }
  if (!dep.dseq) {
    // Pre-bid state — nothing on Akash yet, just mark the row closed.
    await db
      .update(deployments)
      .set({ state: 'closed', closedAt: new Date() })
      .where(eq(deployments.id, dep.id));
    return c.body(null, 204);
  }

  try {
    await consoleApi.closeDeployment(c.get('akashKey'), dep.dseq);
  } catch (err) {
    log.warn('console-api closeDeployment failed; marking row closed anyway', {
      err: String(err),
      functionId: id,
      dseq: dep.dseq,
    });
  }
  await db
    .update(deployments)
    .set({ state: 'closed', closedAt: new Date() })
    .where(eq(deployments.id, dep.id));

  return c.body(null, 204);
});

functionsRouter.delete('/:id', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');
  const fn = await getFn(walletAddress, id);

  // Best-effort: close any live deployment on Akash before tombstoning.
  const dep = await latestDeployment(fn.id);
  if (dep?.dseq && dep.state !== 'closed' && dep.state !== 'failed') {
    try {
      await consoleApi.closeDeployment(c.get('akashKey'), dep.dseq);
      await db
        .update(deployments)
        .set({ state: 'closed', closedAt: new Date() })
        .where(eq(deployments.id, dep.id));
    } catch (err) {
      log.warn('failed to close deployment on Akash, tombstoning anyway', {
        err: String(err),
        functionId: id,
        dseq: dep.dseq,
      });
    }
  }

  await db
    .update(functions)
    .set({ deletedAt: new Date(), status: 'closed' })
    .where(eq(functions.id, id));

  return c.body(null, 204);
});

// ─── helpers ───────────────────────────────────────────────────────────

async function getFn(walletAddress: string, id: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, id), eq(functions.walletAddress, walletAddress), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });
  return fn;
}

async function latestDeployment(functionId: string) {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.functionId, functionId))
    .orderBy(desc(deployments.createdAt))
    .limit(1);
  return row ?? null;
}

function mintSubdomain(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug || 'fn'}-prod-${suffix}`;
}

function toRecord(fn: typeof functions.$inferSelect): FunctionRecord {
  return {
    id: fn.id,
    name: fn.name,
    kind: 'function',
    subdomain: `${fn.subdomain}.akash-functions.io`,
    image: env.RUNNER_IMAGE,
    status: stateToStatus(fn.status),
    createdAt: fn.createdAt.toISOString(),
    updatedAt: fn.updatedAt.toISOString(),
  };
}

function stateToStatus(state: string): FunctionRecord['status'] {
  switch (state) {
    case 'live':
      return 'online';
    case 'pending':
    case 'bidding':
    case 'leased':
      return 'pending';
    case 'failed':
    case 'closed':
      return 'offline';
    default:
      // Unknown — treat as no deployment (orphan / draft).
      return 'idle';
  }
}
