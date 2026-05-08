// Short-lived HMAC tokens for the runner's code-fetch endpoint.
// Token format: base64url(payload).base64url(sig)
//   payload = JSON { fnId, versionId, exp }
//   sig     = HMAC-SHA256(secret, payload)
//
// At deploy time, the SDL embeds CODE_TOKEN=<token> as an env var. The runner
// boots, fetches GET /api/runner/code/:fnId/:versionId?t=<token>, and the
// backend verifies the HMAC + expiry before returning the source tarball.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

type Payload = { fnId: string; versionId: string; exp: number };

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', env.CODE_SIGNING_SECRET).update(payload).digest());
}

export function signCode({
  fnId,
  versionId,
  ttlMs = 15 * 60_000,
}: {
  fnId: string;
  versionId: string;
  ttlMs?: number;
}): string {
  const payload: Payload = { fnId, versionId, exp: Date.now() + ttlMs };
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = sign(encoded);
  return `${encoded}.${sig}`;
}

export function verifyCode(
  token: string,
  expected: { fnId: string; versionId: string }
): { ok: true; payload: Payload } | { ok: false; reason: string } {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [encoded, sig] = parts;
  if (!encoded || !sig) return { ok: false, reason: 'malformed' };

  const expectedSig = sign(encoded);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let payload: Payload;
  try {
    payload = JSON.parse(fromB64url(encoded).toString('utf8')) as Payload;
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }

  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (payload.fnId !== expected.fnId || payload.versionId !== expected.versionId) {
    return { ok: false, reason: 'scope-mismatch' };
  }

  return { ok: true, payload };
}
