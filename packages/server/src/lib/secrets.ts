// AES-256-GCM with per-row random IV. Plaintext is never persisted —
// ciphertext, IV, auth tag, and key version are stored separately on the
// owning row and re-combined on decrypt.
//
// `keyVersion` exists for future key rotation: when V2 ships, add it
// alongside V1, re-encrypt rows row-by-row, and bump their key_version.
// Today only V1 exists.
//
// Two limits exist deliberately:
//   - `secrets.encrypt` (string → 64 KiB) for per-row scalars like
//     function_variables values. Tight cap keeps a single hostile value
//     from ballooning a row.
//   - `encryptJson` / `encryptBytes` (≤ 8 MiB) for whole-blob columns like
//     `function_versions.source`, which already has its own size schema
//     at the API layer ([packages/server/src/routes/functions.ts] —
//     MAX_TOTAL_BYTES = 5 MB).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

const CURRENT_KEY_VERSION = 1;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

const masterKey = (() => {
  const key = Buffer.from(env.MASTER_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error(`MASTER_ENCRYPTION_KEY must be 32 bytes (got ${key.length})`);
  return key;
})();

function keyForVersion(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) {
    throw new Error(`No master key configured for version ${version}`);
  }
  return masterKey;
}

function encipher(plaintext: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyForVersion(CURRENT_KEY_VERSION), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

function decipher(value: EncryptedValue): Buffer {
  const iv = Buffer.from(value.iv, 'base64');
  const tag = Buffer.from(value.authTag, 'base64');
  if (iv.length !== 12) throw new Error(`IV must be 12 bytes (got ${iv.length})`);
  if (tag.length !== 16) throw new Error(`auth tag must be 16 bytes (got ${tag.length})`);

  const d = createDecipheriv('aes-256-gcm', keyForVersion(value.keyVersion), iv);
  d.setAuthTag(tag);
  const ct = Buffer.from(value.ciphertext, 'base64');
  return Buffer.concat([d.update(ct), d.final()]);
}

export const secrets = {
  encrypt(plaintext: string): EncryptedValue {
    if (plaintext.includes('\0')) throw new Error('value contains a null byte');
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
      throw new Error(`value exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
    }
    return encipher(Buffer.from(plaintext, 'utf8'));
  },

  decrypt(value: EncryptedValue): string {
    return decipher(value).toString('utf8');
  },
};

export function encryptBytes(buf: Buffer): EncryptedValue {
  if (buf.byteLength > MAX_BLOB_BYTES) {
    throw new Error(`blob exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  return encipher(buf);
}

export function decryptBytes(value: EncryptedValue): Buffer {
  return decipher(value);
}

export function encryptJson<T>(value: T): EncryptedValue {
  return encryptBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

export function decryptJson<T>(value: EncryptedValue): T {
  return JSON.parse(decryptBytes(value).toString('utf8')) as T;
}
