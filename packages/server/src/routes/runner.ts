// /api/runner/code/:fnId/:versionId — the runner image hits this at container
// boot to pull the user's source. Auth is the HMAC token in the `t` query
// param (signed by signCode at deploy time). Returns a tarball.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client';
import { functionVersions } from '../db/schema';
import { verifyCode } from '../lib/signing';

export const runnerRouter = new Hono();

// Public — no auth middleware. Verification happens on the HMAC token.
runnerRouter.get('/code/:fnId/:versionId', async (c) => {
  const fnId = c.req.param('fnId');
  const versionId = c.req.param('versionId');
  // Token can come from query or Authorization header (Bearer <token>).
  const authHeader = c.req.header('authorization') ?? c.req.header('Authorization');
  const headerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : undefined;
  const token = c.req.query('t') ?? headerToken;
  if (!token) throw new HTTPException(401, { message: 'Missing CODE_TOKEN' });

  const verified = verifyCode(token, { fnId, versionId });
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
    // Wrap Node Buffer in a Blob — works as BodyInit across both DOM
    // and undici Response types.
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
