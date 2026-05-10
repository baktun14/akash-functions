// /api/keys — wallet-scoped API keys used to authenticate calls to function
// routes the manifest declared as `auth: 'apiKey'`. Plaintext is generated and
// returned exactly once on POST; only the SHA-256 hash is stored.

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type {
  ApiKeyRecord,
  CreateApiKeyResponse,
} from '@shared/types';
import { db } from '../db/client';
import { apiKeys } from '../db/schema';
import { type AuthVars, requireAkashKey } from '../middleware/auth';

const CreateBody = z.object({
  name: z.string().min(1).max(60).trim(),
});

const KEY_PREFIX = 'akf_';

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function generatePlaintextKey(): string {
  // 24 random bytes → 32 url-safe chars after base64url. Total length 36.
  return KEY_PREFIX + randomBytes(24).toString('base64url');
}

function tail4(plaintext: string): string {
  return plaintext.slice(-4);
}

export const keysRouter = new Hono<{ Variables: AuthVars }>();

keysRouter.use('*', requireAkashKey);

keysRouter.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      maskedTail: apiKeys.maskedTail,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.walletAddress, walletAddress))
    .orderBy(asc(apiKeys.createdAt));

  const list: ApiKeyRecord[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    maskedTail: r.maskedTail,
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json(list);
});

keysRouter.post('/', zValidator('json', CreateBody), async (c) => {
  const walletAddress = c.get('walletAddress');
  const { name } = c.req.valid('json');

  const plaintext = generatePlaintextKey();
  const keyHash = hashApiKey(plaintext);
  const maskedTail = tail4(plaintext);

  const [row] = await db
    .insert(apiKeys)
    .values({ walletAddress, name, keyHash, maskedTail })
    .returning();
  if (!row) throw new HTTPException(500, { message: 'Failed to insert api key' });

  const body: CreateApiKeyResponse = {
    id: row.id,
    name: row.name,
    key: plaintext,
    maskedTail: row.maskedTail,
    createdAt: row.createdAt.toISOString(),
  };
  return c.json(body, 201);
});

keysRouter.delete('/:id', async (c) => {
  const walletAddress = c.get('walletAddress');
  const id = c.req.param('id');

  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.walletAddress, walletAddress)))
    .returning({ id: apiKeys.id });
  if (result.length === 0) {
    throw new HTTPException(404, { message: 'API key not found' });
  }
  return c.body(null, 204);
});
