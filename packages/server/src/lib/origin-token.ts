import { createHash, randomBytes } from 'node:crypto';

export const ORIGIN_TOKEN_QUERY = '__akash_origin';
export const ORIGIN_TOKEN_HEADER = 'x-akash-origin-token';

export function createOriginToken(): string {
  return `afo_${randomBytes(32).toString('base64url')}`;
}

export function createAliasPublicId(): string {
  return `afn_${randomBytes(18).toString('base64url')}`;
}

export function hashOriginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
