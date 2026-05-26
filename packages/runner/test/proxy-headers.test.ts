import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN_TOKEN_HEADER, userCodeProxyHeaders } from '../proxy-headers.ts';

test('removes origin tokens and hop-by-hop headers before user code', () => {
  const input = new Headers({
    authorization: 'Bearer caller-key',
    connection: 'keep-alive',
    host: 'provider.example',
    [ORIGIN_TOKEN_HEADER]: 'afo_secret',
    'x-custom': 'kept',
  });

  const headers = userCodeProxyHeaders(input);

  assert.equal(headers.get(ORIGIN_TOKEN_HEADER), null);
  assert.equal(headers.get('connection'), null);
  assert.equal(headers.get('host'), null);
  assert.equal(headers.get('authorization'), 'Bearer caller-key');
  assert.equal(headers.get('x-custom'), 'kept');
});
