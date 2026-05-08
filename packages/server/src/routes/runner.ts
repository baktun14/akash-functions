// /api/runner/* — endpoints the runner image calls back into.
//
// /code/:fnId/:versionId   returns a tarball of the source. Accepts a runner
//                          or code token (the runner image polls this whenever
//                          it sees a new version).
// /current/:fnId           returns { versionId, updatedAt } for the latest
//                          version. Polled by the runner every POLL_INTERVAL_MS.
//
// Auth is the HMAC token in the `t` query param or `Authorization: Bearer`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client';
import { functionVersions, functions } from '../db/schema';
import { verifyToken } from '../lib/signing';

export const runnerRouter = new Hono();

function extractToken(c: Context): string {
  const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
  const headerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : undefined;
  const token = c.req.query('t') ?? headerToken;
  if (!token) throw new HTTPException(401, { message: 'Missing token' });
  return token;
}

// Public — no auth middleware. Verification happens on the HMAC token.
runnerRouter.get('/code/:fnId/:versionId', async (c) => {
  const fnId = c.req.param('fnId');
  const versionId = c.req.param('versionId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, versionId, allowKinds: ['runner', 'code'] });
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  const [version] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.id, versionId))
    .limit(1);
  if (!version || version.functionId !== fnId) {
    throw new HTTPException(404, { message: 'Version not found' });
  }

  // Materialize source files into a tmp dir, then `tar -cz` it.
  const dir = await mkdtemp(path.join(tmpdir(), 'fn-'));
  try {
    for (const [relPath, contents] of Object.entries(version.source)) {
      const safeRel = sanitizeRelPath(relPath);
      const target = path.join(dir, safeRel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, 'utf8');
    }

    const tarball = await tarGzip(dir);
    const body = new Blob([new Uint8Array(tarball)], { type: 'application/gzip' });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${fnId}-${versionId}.tar.gz"`,
      },
    });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Latest version pointer for a function. The runner polls this on its
// POLL_INTERVAL_MS cadence; on a change it fetches /code/:fnId/:newVersionId
// and hot-swaps /app.
runnerRouter.get('/current/:fnId', async (c) => {
  const fnId = c.req.param('fnId');
  const token = extractToken(c);

  const verified = verifyToken(token, { fnId, allowKinds: ['runner'] });
  if (!verified.ok) {
    throw new HTTPException(401, { message: `Invalid token: ${verified.reason}` });
  }

  // 404 if the function was deleted (tombstoned). The runner uses this as a
  // signal to exit cleanly so the Akash provider can release the lease.
  const [fn] = await db
    .select({ id: functions.id })
    .from(functions)
    .where(and(eq(functions.id, fnId), isNull(functions.deletedAt)))
    .limit(1);
  if (!fn) throw new HTTPException(404, { message: 'Function not found' });

  const [version] = await db
    .select({ id: functionVersions.id, createdAt: functionVersions.createdAt })
    .from(functionVersions)
    .where(eq(functionVersions.functionId, fnId))
    .orderBy(desc(functionVersions.createdAt))
    .limit(1);
  if (!version) throw new HTTPException(404, { message: 'No versions for function' });

  c.header('Cache-Control', 'no-store');
  return c.json({
    versionId: version.id,
    updatedAt: version.createdAt.toISOString(),
  });
});

function sanitizeRelPath(p: string): string {
  // Strip leading slashes and "..", normalise separators, prevent path traversal.
  const cleaned = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new HTTPException(400, { message: `Invalid path in source: ${p}` });
  }
  return cleaned;
}

function tarGzip(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', '-', '-C', dir, '.']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
