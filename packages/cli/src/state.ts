import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEPLOYMENTS_FILE,
  ensureStateDir,
  REWRITES_FILE,
  STATE_DIR,
} from './config.js';
import type {
  DeploymentState,
  DiscoveredRoute,
  RewriteEntry,
  UpsertResponse,
} from './types.js';

export async function writeDeploymentState(
  cwd: string,
  state: DeploymentState,
): Promise<void> {
  const dir = await ensureStateDir(cwd);
  await writeFile(
    path.join(dir, DEPLOYMENTS_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(dir, REWRITES_FILE),
    `${JSON.stringify(state.rewrites, null, 2)}\n`,
    'utf8',
  );
}

export async function readDeploymentState(cwd: string): Promise<DeploymentState> {
  const file = path.join(cwd, STATE_DIR, DEPLOYMENTS_FILE);
  return JSON.parse(await readFile(file, 'utf8')) as DeploymentState;
}

export async function patchVercelOutput(cwd: string): Promise<{
  configPatched: boolean;
  removedFunctions: string[];
}> {
  const state = await readDeploymentState(cwd);
  const outputDir = path.join(cwd, '.vercel/output');
  const configPath = path.join(outputDir, 'config.json');
  const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
    routes?: unknown[];
    [key: string]: unknown;
  };

  const externalRoutes = state.rewrites.map(rewriteToOutputRoute);
  rawConfig.routes = [
    ...externalRoutes,
    ...(Array.isArray(rawConfig.routes) ? rawConfig.routes : []),
  ];
  await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');

  const removedFunctions: string[] = [];
  for (const fn of state.functions) {
    for (const candidate of functionOutputCandidates(outputDir, fn.route)) {
      try {
        await rm(candidate, { recursive: true, force: false });
        removedFunctions.push(path.relative(cwd, candidate));
      } catch {
        // Next/Vercel output names vary by framework version; best-effort.
      }
    }
  }

  return { configPatched: true, removedFunctions };
}

export function buildRewrite(route: DiscoveredRoute, response: UpsertResponse): RewriteEntry | null {
  const base = response.stableUrl ?? response.ingressUrl;
  if (!base) return null;
  const destination = `${base.replace(/\/$/, '')}${route.vercelSource}`;
  return {
    source: route.vercelSource,
    destination: response.originToken
      ? appendOriginToken(destination, response.originToken)
      : destination,
  };
}

function appendOriginToken(destination: string, token: string): string {
  const separator = destination.includes('?') ? '&' : '?';
  return `${destination}${separator}__akash_origin=${encodeURIComponent(token)}`;
}

function rewriteToOutputRoute(rewrite: RewriteEntry): { src: string; dest: string } {
  let capture = 0;
  let dest = rewrite.destination;
  const src = rewrite.source
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegex(segment);
      capture += 1;
      const catchAll = segment.endsWith('*');
      const name = segment.slice(1, catchAll ? -1 : undefined);
      dest = dest.replace(`:${name}${catchAll ? '*' : ''}`, `$${capture}`);
      return catchAll ? '(.*)' : '([^/]+)';
    })
    .join('/');
  return { src: `^${src}$`, dest };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionOutputCandidates(outputDir: string, route: string): string[] {
  const noLeading = route.replace(/^\//, '');
  const withoutGroups = noLeading.replace(/\(.+?\)\//g, '');
  const candidates = [
    withoutGroups,
    withoutGroups.replace(/\[([^\]]+)\]/g, '[$1]'),
    withoutGroups.replace(/\[\.\.\.([^\]]+)\]/g, '[...$1]'),
  ];
  return Array.from(new Set(candidates.flatMap((candidate) => [
    path.join(outputDir, 'functions', `${candidate}.func`),
    path.join(outputDir, 'functions', `${candidate}.rsc.func`),
  ])));
}
