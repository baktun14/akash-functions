// HMAC tokens used by the runner image to call back to the backend.
// Token format: base64url(payload).base64url(sig)
//   payload = JSON { kind, fnId, versionId?, exp, iat }
//   sig     = HMAC-SHA256(secret, payload)
//
// Two kinds:
//   - 'code'   short-lived (15 min), scoped to a single { fnId, versionId }.
//              Used historically; still accepted by /api/runner/code/...
//   - 'runner' long-lived (30 days), scoped to fnId only. Embedded in the SDL
//              as RUNNER_TOKEN. Authorises the runner to poll the current
//              version and fetch any version of its own function.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

export type TokenKind = 'code' | 'runner';
export type Payload = {
  kind: TokenKind;
  fnId: string;
  versionId?: string;
  exp: number;
  iat: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_TOKEN_DEFAULT_TTL_MS = 15 * 60_000;
const RUNNER_TOKEN_DEFAULT_TTL_MS = 30 * DAY_MS;

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

function encode(payload: Payload): string {
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  return `${encoded}.${sign(encoded)}`;
}

export function signCode({
  fnId,
  versionId,
  ttlMs = CODE_TOKEN_DEFAULT_TTL_MS,
}: {
  fnId: string;
  versionId: string;
  ttlMs?: number;
}): string {
  const now = Date.now();
  return encode({ kind: 'code', fnId, versionId, exp: now + ttlMs, iat: now });
}

export function signRunner({
  fnId,
  ttlMs = RUNNER_TOKEN_DEFAULT_TTL_MS,
}: {
  fnId: string;
  ttlMs?: number;
}): string {
  const now = Date.now();
  return encode({ kind: 'runner', fnId, exp: now + ttlMs, iat: now });
}

type VerifyOk = { ok: true; payload: Payload };
type VerifyErr = { ok: false; reason: string };
type VerifyResult = VerifyOk | VerifyErr;

export function verifyToken(
  token: string,
  expected: { fnId: string; versionId?: string; allowKinds: TokenKind[] }
): VerifyResult {
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

  if (!payload.kind || !expected.allowKinds.includes(payload.kind)) {
    return { ok: false, reason: 'kind-mismatch' };
  }
  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (payload.fnId !== expected.fnId) return { ok: false, reason: 'scope-mismatch' };

  // Code-kind tokens are pinned to a specific versionId; enforce when the
  // caller cares. Runner-kind tokens are deliberately function-scoped.
  if (payload.kind === 'code' && expected.versionId !== undefined && payload.versionId !== expected.versionId) {
    return { ok: false, reason: 'scope-mismatch' };
  }

  return { ok: true, payload };
}

// Back-compat shim. Prefer verifyToken in new code.
export function verifyCode(
  token: string,
  expected: { fnId: string; versionId: string }
): VerifyResult {
  return verifyToken(token, { ...expected, allowKinds: ['code'] });
}
