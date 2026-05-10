// AES-256-GCM with per-row random IV. Plaintext is never persisted —
// ciphertext, IV, auth tag, and key version are stored separately in
// function_variables and re-combined on decrypt.
//
// `keyVersion` exists for future key rotation: when V2 ships, add it
// alongside V1, re-encrypt rows row-by-row, and bump their key_version.
// Today only V1 exists.

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

export const secrets = {
  encrypt(plaintext: string): EncryptedValue {
    if (plaintext.includes('\0')) throw new Error('value contains a null byte');
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
      throw new Error(`value exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyForVersion(CURRENT_KEY_VERSION), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: ct.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: CURRENT_KEY_VERSION,
    };
  },

  decrypt(value: EncryptedValue): string {
    const iv = Buffer.from(value.iv, 'base64');
    const tag = Buffer.from(value.authTag, 'base64');
    if (iv.length !== 12) throw new Error(`IV must be 12 bytes (got ${iv.length})`);
    if (tag.length !== 16) throw new Error(`auth tag must be 16 bytes (got ${tag.length})`);

    const decipher = createDecipheriv('aes-256-gcm', keyForVersion(value.keyVersion), iv);
    decipher.setAuthTag(tag);
    const ct = Buffer.from(value.ciphertext, 'base64');
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  },
};
