import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../src/commands.ts';
import type { DeploymentState, UpsertResponse } from '../src/types.ts';

test('deploy builds routes, upserts them, waits for live deployment, and writes rewrites', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'akash-cli-deploy-'));
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    AKASH_CONSOLE_API_KEY: process.env.AKASH_CONSOLE_API_KEY,
    AKASHML_API_KEY: process.env.AKASHML_API_KEY,
    EXPLICIT_ENV: process.env.EXPLICIT_ENV,
    PORT: process.env.PORT,
  };
  const logs = await withCapturedLogs(async () => {
    try {
      await writeFixtureApp(cwd);
      process.env.AKASH_CONSOLE_API_KEY = 'console-key';
      process.env.AKASHML_API_KEY = 'source-secret';
      process.env.EXPLICIT_ENV = 'config-secret';
      process.env.PORT = 'reserved-runtime-value';

      const requests: CapturedRequest[] = [];
      globalThis.fetch = mockControlPlaneFetch(requests);

      await runCli(['deploy', '--cwd', cwd, '--api-base', 'http://control.local']);

      const upsert = requests.find((request) => request.path === '/api/functions/vercel/upsert');
      assert.ok(upsert);
      const upsertSource = stringRecord(upsert.body.source);
      const upsertName = stringValue(upsert.body.name);
      assert.equal(upsert.method, 'POST');
      assert.equal(upsert.authorization, 'Bearer console-key');
      assert.equal(upsert.body.project, 'fixture-app');
      assert.equal(upsertName.startsWith('vercel-hello-'), true);
      assert.equal(upsert.body.route, '/api/hello/[name]');
      assert.equal(upsert.body.kind, 'pages-api');
      assert.equal(upsert.body.deploy, true);
      assert.deepEqual(upsert.body.resources, {
        cpu: '1',
        memory: '1Gi',
        storage: '2Gi',
      });
      assert.deepEqual(upsert.body.envVars, {
        AKASHML_API_KEY: 'source-secret',
        EXPLICIT_ENV: 'config-secret',
      });
      assert.equal(typeof upsertSource['src/index.ts'], 'string');
      assert.equal(typeof upsertSource['src/user-handler.mjs'], 'string');
      assert.equal(typeof upsertSource['src/compat/pages-api.ts'], 'string');
      assert.match(
        upsertSource['src/index.ts'] ?? '',
        /createPagesApiFetch/,
      );

      assert.ok(
        requests.some((request) => request.path === '/api/functions/fn_123/deployments/dep_123'),
      );

      const state = JSON.parse(
        await readFile(path.join(cwd, '.akash-functions/deployments.json'), 'utf8'),
      ) as DeploymentState;
      assert.equal(state.project, 'fixture-app');
      assert.deepEqual(state.functions, [
        {
          name: upsertName,
          route: '/api/hello/[name]',
          source: 'pages/api/hello/[name].js',
          functionId: 'fn_123',
          versionId: 'ver_123',
          deploymentId: 'dep_123',
          ingressUrl: 'provider.example',
          stableUrl: 'https://functions.akash.network/i/afn_123',
        },
      ]);
      assert.deepEqual(state.rewrites, [
        {
          source: '/api/hello/:name',
          destination:
            'https://functions.akash.network/i/afn_123/api/hello/:name?__akash_origin=origin%20secret',
        },
      ]);

      const rewrites = JSON.parse(
        await readFile(path.join(cwd, '.akash-functions/rewrites.json'), 'utf8'),
      );
      assert.deepEqual(rewrites, state.rewrites);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv(originalEnv);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  assert.ok(logs.some((line) => line.includes('/api/hello/[name] -> https://functions.akash.network/i/afn_123')));
});

type CapturedRequest = {
  path: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

function mockControlPlaneFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body,
    });

    if (url.pathname === '/api/functions/vercel/upsert') {
      const response: UpsertResponse = {
        function: { id: 'fn_123', name: String(body.name) },
        versionId: 'ver_123',
        deploymentId: 'dep_123',
        stableUrl: 'https://functions.akash.network/i/afn_123',
        originToken: 'origin secret',
        action: 'deployed',
      };
      return Response.json(response, { status: 201 });
    }

    if (url.pathname === '/api/functions/fn_123/deployments/dep_123') {
      return Response.json({
        id: 'dep_123',
        functionId: 'fn_123',
        versionId: 'ver_123',
        state: 'live',
        uris: ['provider.example'],
      });
    }

    return new Response('unexpected request', { status: 500 });
  }) as typeof fetch;
}

function stringValue(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isStringRecord(value)) {
    assert.fail('expected a string record');
  }
  return value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

async function writeFixtureApp(cwd: string): Promise<void> {
  await writeJson(path.join(cwd, 'package.json'), { name: 'fixture-app' });
  await writeJson(path.join(cwd, 'akash-functions.config.json'), {
    project: 'fixture-app',
    target: 'vercel',
    functions: {
      include: ['pages/api/hello/[name].js'],
      env: ['EXPLICIT_ENV', 'PORT'],
      resources: {
        cpu: '1',
        memory: '1Gi',
        storage: '2Gi',
      },
      wait: true,
    },
  });
  await writeText(
    path.join(cwd, 'pages/api/hello/[name].js'),
    [
      'export default function handler(req, res) {',
      '  const secret = process.env.AKASHML_API_KEY;',
      '  const runtimeOnly = process.env.PORT;',
      '  res.status(200).json({ name: req.query.name, secret, runtimeOnly });',
      '}',
      '',
    ].join('\n'),
  );
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value, 'utf8');
}

async function withCapturedLogs(run: () => Promise<void>): Promise<string[]> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await run();
    return logs;
  } finally {
    console.log = originalLog;
  }
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
