import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AkashFunctionsConfig, DiscoveredRoute, RouteKind } from './types.js';

const ROUTE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

export async function discoverVercelRoutes(
  cwd: string,
  config: AkashFunctionsConfig,
): Promise<DiscoveredRoute[]> {
  const routes: DiscoveredRoute[] = [];
  const pagesDir = path.join(cwd, 'src/pages/api');
  const appDir = path.join(cwd, 'src/app/api');

  for (const file of await walkIfExists(pagesDir)) {
    if (!isRouteFile(file)) continue;
    const rel = toPosix(path.relative(cwd, file));
    if (!isIncluded(rel, config)) continue;
    routes.push(makeRoute('pages-api', cwd, file));
  }

  for (const file of await walkIfExists(appDir)) {
    if (!isRouteFile(file)) continue;
    if (!/\/route\.[^.]+$/.test(toPosix(file))) continue;
    const rel = toPosix(path.relative(cwd, file));
    if (!isIncluded(rel, config)) continue;
    routes.push(makeRoute('app-route', cwd, file));
  }

  return routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

function makeRoute(kind: RouteKind, cwd: string, file: string): DiscoveredRoute {
  const rel = toPosix(path.relative(cwd, file));
  const nextPattern = kind === 'pages-api'
    ? pagesApiPattern(rel)
    : appRoutePattern(rel);
  const routePath = nextPatternToConcretePath(nextPattern);
  const vercelSource = nextPatternToVercelSource(nextPattern);
  const hash = createHash('sha256').update(`${kind}:${rel}:${nextPattern}`).digest('hex').slice(0, 10);
  const name = routeName(nextPattern, hash);
  return {
    kind,
    file,
    nextPattern,
    routePath,
    vercelSource,
    name,
  };
}

function pagesApiPattern(rel: string): string {
  let route = rel
    .replace(/^src\/pages\/api\//, '/api/')
    .replace(/\.[^.]+$/, '');
  route = route.replace(/\/index$/, '');
  return route || '/api';
}

function appRoutePattern(rel: string): string {
  let route = rel
    .replace(/^src\/app\/api\//, '/api/')
    .replace(/\/route\.[^.]+$/, '');
  route = route.replace(/\/index$/, '');
  return route || '/api';
}

function nextPatternToConcretePath(pattern: string): string {
  const route = pattern
    .split('/')
    .map((segment) => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return '';
      if (/^\[\.\.\..+\]$/.test(segment)) return '';
      if (/^\[.+\]$/.test(segment)) return `:${segment.slice(1, -1)}`;
      return segment;
    })
    .filter(Boolean)
    .join('/');
  return route ? `/${route}` : '/';
}

function nextPatternToVercelSource(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (/^\[\[\.\.\..+\]\]$/.test(segment)) return `:${segment.slice(5, -2)}*`;
      if (/^\[\.\.\..+\]$/.test(segment)) return `:${segment.slice(4, -1)}*`;
      if (/^\[.+\]$/.test(segment)) return `:${segment.slice(1, -1)}`;
      return segment;
    })
    .join('/') || '/';
}

function routeName(pattern: string, hash: string): string {
  const slug = pattern
    .toLowerCase()
    .replace(/^\/api\/?/, '')
    .replace(/\[[.\w-]+\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38);
  return `vercel-${slug || 'api'}-${hash}`;
}

async function walkIfExists(dir: string): Promise<string[]> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkIfExists(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isRouteFile(file: string): boolean {
  return ROUTE_EXTENSIONS.has(path.extname(file));
}

function isIncluded(rel: string, config: AkashFunctionsConfig): boolean {
  const include = config.functions?.include ?? [];
  const exclude = config.functions?.exclude ?? [];
  const included = include.length === 0 || include.some((pattern) => globishMatch(pattern, rel));
  if (!included) return false;
  return !exclude.some((pattern) => globishMatch(pattern, rel));
}

function globishMatch(pattern: string, rel: string): boolean {
  const normalizedPattern = toPosix(pattern);
  const normalizedRel = toPosix(rel);
  const placeholder = '\u0000GLOBSTAR\u0000';
  const regex = new RegExp(
    '^' + normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, placeholder)
      .replace(/\*/g, '[^/]*')
      .replaceAll(placeholder, '.*') + '$',
  );
  return regex.test(normalizedRel);
}

function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}
