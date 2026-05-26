import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAliasPublicId,
  createOriginToken,
  hashOriginToken,
  timingSafeHexEqual,
} from '../src/lib/origin-token.ts';

test('origin tokens and alias ids use opaque public-safe prefixes', () => {
  assert.match(createOriginToken(), /^afo_[A-Za-z0-9_-]{43}$/);
  assert.match(createAliasPublicId(), /^afn_[A-Za-z0-9_-]{24}$/);
});

test('origin-token hashes compare without accepting wrong values', () => {
  const hash = hashOriginToken('origin secret');
  assert.equal(timingSafeHexEqual(hash, hashOriginToken('origin secret')), true);
  assert.equal(timingSafeHexEqual(hash, hashOriginToken('other secret')), false);
  assert.equal(timingSafeHexEqual(hash, hash.slice(1)), false);
});
