// /api/functions — CRUD for function records and their version history.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { FunctionRecord } from '@shared/types';
import { consoleApi } from '../akash/console-client';
import { db } from '../db/client';
import { deployments, functionVersions, functions } from '../db/schema';
import { env } from '../env';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

const ResourceSchema = z.object({
  cpu: z.string(),
  memory: z.string(),
  storage: z.string(),
});

const CreateBody = z.object({
  name: z.string().min(1).max(60),
  preset: z.enum(['rest', 'jsx', 'cron', 'gpu']),
  prompt: z.string().optional(),
  source: z.record(z.string(), z.string()),
  resources: ResourceSchema,
  envVars: z.record(z.string(), z.string()).optional(),
});

const UpdateNameBody = z.object({ name: z.string().min(1).max(60) });

const UpdateCodeBody = z.object({
  source: z.record(z.string(), z.string()),
  resources: ResourceSchema.optional(),
  envVars: z.record(z.string(), z.string()).optional(),
});

export const functionsRouter = new Hono<{ Variables: AuthVars }>();

functionsRouter.use('*', requireAkashKey);

functionsRouter.get('/', async (c) => {
  const ownerHash = c.get('ownerHash');
  const rows = await db
    .select()
    .from(functions)
    .where(and(eq(functions.ownerHash, ownerHash), isNull(functions.deletedAt)))
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
        status: stateToStatus(dep?.state ?? fn.status),
        latestDeploymentId: dep?.id,
      };
    })
  );

  return c.json(list);
});

functionsRouter.post('/', zValidator('json', CreateBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const body = c.req.valid('json');
  const subdomain = mintSubdomain(body.name);

  const inserted = await db.transaction(async (tx) => {
    const [fn] = await tx
      .insert(functions)
      .values({
        ownerHash,
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
  const ownerHash = c.get('ownerHash');
  const id = c.req.param('id');
  const fn = await getFn(ownerHash, id);
  return c.json(toRecord(fn));
});

functionsRouter.put('/:id', zValidator('json', UpdateNameBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const id = c.req.param('id');
  await getFn(ownerHash, id);
  const [updated] = await db
    .update(functions)
    .set({ name: c.req.valid('json').name, updatedAt: new Date() })
    .where(eq(functions.id, id))
    .returning();
  if (!updated) throw new HTTPException(500, { message: 'Update failed' });
  return c.json(toRecord(updated));
});

functionsRouter.put('/:id/code', zValidator('json', UpdateCodeBody), async (c) => {
  const ownerHash = c.get('ownerHash');
  const id = c.req.param('id');
  await getFn(ownerHash, id);
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
      source: body.source,
      resources: body.resources ?? latest?.resources ?? { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
      envVars: body.envVars ?? latest?.envVars ?? {},
    })
    .returning();
  if (!version) throw new HTTPException(500, { message: 'Insert failed' });
  return c.json({ id: version.id, createdAt: version.createdAt }, 201);
});

functionsRouter.delete('/:id', async (c) => {
  const ownerHash = c.get('ownerHash');
  const id = c.req.param('id');
  const fn = await getFn(ownerHash, id);

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

async function getFn(ownerHash: string, id: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, id), eq(functions.ownerHash, ownerHash), isNull(functions.deletedAt)))
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
      return 'offline';
    default:
      return 'pending';
  }
}
