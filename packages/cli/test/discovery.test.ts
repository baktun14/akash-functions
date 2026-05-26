import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverVercelRoutes } from '../src/discovery.ts';
import type { AkashFunctionsConfig } from '../src/types.js';

const config: AkashFunctionsConfig = {
  target: 'vercel',
  functions: {
    exclude: ['**/*.test.*'],
  },
};

test('discovers root and src Next API route layouts', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'akash-cli-discovery-'));
  try {
    await writeRoute(cwd, 'pages/api/root-pages/index.ts');
    await writeRoute(cwd, 'app/api/root-app/route.ts');
    await writeRoute(cwd, 'src/pages/api/src-pages.ts');
    await writeRoute(cwd, 'src/app/api/src-app/route.ts');
    await writeRoute(cwd, 'src/pages/api/ignored.test.ts');

    const routes = await discoverVercelRoutes(cwd, config);
    assert.deepEqual(
      routes.map((route) => ({
        kind: route.kind,
        nextPattern: route.nextPattern,
        file: path.relative(cwd, route.file).replace(/\\/g, '/'),
      })),
      [
        {
          kind: 'app-route',
          nextPattern: '/api/root-app',
          file: 'app/api/root-app/route.ts',
        },
        {
          kind: 'pages-api',
          nextPattern: '/api/root-pages',
          file: 'pages/api/root-pages/index.ts',
        },
        {
          kind: 'app-route',
          nextPattern: '/api/src-app',
          file: 'src/app/api/src-app/route.ts',
        },
        {
          kind: 'pages-api',
          nextPattern: '/api/src-pages',
          file: 'src/pages/api/src-pages.ts',
        },
      ],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function writeRoute(cwd: string, rel: string): Promise<void> {
  const file = path.join(cwd, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'export default function handler() {}\n', 'utf8');
}
