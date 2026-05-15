// AES-256-GCM-encrypted user code for `function_versions.source_*` columns.
// Plaintext is never persisted; this module is the only path that crosses
// the encryption boundary.

import { encryptJson, decryptJson } from './secrets';

export type SourceMap = Record<string, string>;

type RowWithSource = {
  sourceCiphertext: string;
  sourceIv: string;
  sourceAuthTag: string;
  sourceKeyVersion: number;
};

export function readSource(row: RowWithSource): SourceMap {
  return decryptJson<SourceMap>({
    ciphertext: row.sourceCiphertext,
    iv: row.sourceIv,
    authTag: row.sourceAuthTag,
    keyVersion: row.sourceKeyVersion,
  });
}

// Insert-side helper: returns the four ciphertext columns for a
// `function_versions` insert. Spread directly into `.values({...})`.
export function encryptedSourceColumns(source: SourceMap): RowWithSource {
  const enc = encryptJson(source);
  return {
    sourceCiphertext: enc.ciphertext,
    sourceIv: enc.iv,
    sourceAuthTag: enc.authTag,
    sourceKeyVersion: enc.keyVersion,
  };
}
