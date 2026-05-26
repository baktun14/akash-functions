import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withAkashFunctions } from '../src/next.ts';

const generatedRewrite = {
  source: '/api/hello/:name',
  destination: 'https://functions.akash.network/i/afn_123/api/hello/:name?__akash_origin=secret',
};

test('withAkashFunctions prepends generated rewrites to array rewrites', async () => {
  await withTempCwd(async (cwd) => {
    await writeGeneratedRewrites(cwd);
    const config = withAkashFunctions({
      async rewrites() {
        return [{ source: '/local', destination: '/api/local' }];
      },
    });

    assert.deepEqual(await config.rewrites(), [
      generatedRewrite,
      { source: '/local', destination: '/api/local' },
    ]);
  });
});

test('withAkashFunctions prepends generated rewrites to beforeFiles groups', async () => {
  await withTempCwd(async (cwd) => {
    await writeGeneratedRewrites(cwd);
    const config = withAkashFunctions({
      rewrites() {
        return {
          beforeFiles: [{ source: '/before', destination: '/api/before' }],
          afterFiles: [{ source: '/after', destination: '/api/after' }],
        };
      },
    });

    assert.deepEqual(await config.rewrites(), {
      beforeFiles: [
        generatedRewrite,
        { source: '/before', destination: '/api/before' },
      ],
      afterFiles: [{ source: '/after', destination: '/api/after' }],
    });
  });
});

async function writeGeneratedRewrites(cwd: string): Promise<void> {
  const file = path.join(cwd, '.akash-functions/rewrites.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify([generatedRewrite], null, 2)}\n`, 'utf8');
}

async function withTempCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const original = process.cwd();
  const cwd = await mkdtemp(path.join(tmpdir(), 'akash-cli-next-'));
  try {
    process.chdir(cwd);
    await run(cwd);
  } finally {
    process.chdir(original);
    await rm(cwd, { recursive: true, force: true });
  }
}
