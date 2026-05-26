import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForDeploymentVersion } from '../src/api.ts';

test('waitForDeploymentVersion returns when the requested version is live', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = jsonFetch({
      id: 'dep_123',
      functionId: 'fn_123',
      versionId: 'ver_new',
      state: 'live',
      uris: ['provider.example'],
    });

    const deployment = await waitForDeploymentVersion(
      'http://control.local',
      'console-key',
      'fn_123',
      'dep_123',
      'ver_new',
      1,
    );

    assert.deepEqual(deployment.uris, ['provider.example']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('waitForDeploymentVersion fails when the old version stays live after a probe error', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = jsonFetch({
      id: 'dep_123',
      functionId: 'fn_123',
      versionId: 'ver_old',
      state: 'live',
      errorMessage: 'candidate probe failed',
    });

    await assert.rejects(
      waitForDeploymentVersion(
        'http://control.local',
        'console-key',
        'fn_123',
        'dep_123',
        'ver_new',
        1,
      ),
      /candidate probe failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonFetch(body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/functions/fn_123/deployments/dep_123');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer console-key');
    return Response.json(body);
  }) as typeof fetch;
}
