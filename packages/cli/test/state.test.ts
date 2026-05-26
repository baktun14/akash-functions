import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { patchVercelOutput, writeDeploymentState } from '../src/state.ts';
import type { DeploymentState } from '../src/types.ts';

test('patch-output prepends external rewrites and removes Vercel function artifacts', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'akash-cli-output-'));
  try {
    const state: DeploymentState = {
      generatedAt: '2026-05-25T00:00:00.000Z',
      project: 'fixture-app',
      target: 'vercel',
      functions: [
        {
          name: 'vercel-hello',
          route: '/api/hello/[name]',
          source: 'pages/api/hello/[name].ts',
          functionId: 'fn_123',
          versionId: 'ver_123',
          deploymentId: 'dep_123',
          stableUrl: 'https://functions.akash.network/i/afn_123',
        },
      ],
      rewrites: [
        {
          source: '/api/hello/:name',
          destination:
            'https://functions.akash.network/i/afn_123/api/hello/:name?__akash_origin=secret',
        },
      ],
    };
    await writeDeploymentState(cwd, state);

    const outputDir = path.join(cwd, '.vercel/output');
    await writeJson(path.join(outputDir, 'config.json'), {
      version: 3,
      routes: [{ src: '^/existing$', dest: '/existing' }],
    });
    await writeText(
      path.join(outputDir, 'functions/api/hello/[name].func/index.js'),
      'module.exports = {};\n',
    );

    const result = await patchVercelOutput(cwd);
    assert.deepEqual(result, {
      configPatched: true,
      removedFunctions: ['.vercel/output/functions/api/hello/[name].func'],
    });

    const config = JSON.parse(
      await readFile(path.join(outputDir, 'config.json'), 'utf8'),
    ) as { routes: Array<{ src: string; dest: string }> };
    assert.deepEqual(config.routes, [
      {
        src: '^/api/hello/([^/]+)$',
        dest: 'https://functions.akash.network/i/afn_123/api/hello/$1?__akash_origin=secret',
      },
      { src: '^/existing$', dest: '/existing' },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, 'utf8');
}
