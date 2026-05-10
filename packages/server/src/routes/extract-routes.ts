// Detect HTTP routes by scanning the function's source for two common
// patterns:
//
//   1. `<router>.<verb>("/path", ...)` — the registration call shared by
//      Hono, Express, Fastify, Koa-router, Elysia, and most other modern
//      Node/Bun web frameworks.
//   2. `Bun.serve({ routes: { "/path": handler | { GET, POST, ... } } })` —
//      Bun 1.2+ declarative routing.
//
// The user's code is the source of truth — no separate manifest.
//
// Tradeoffs (kept simple on purpose):
//   - Routes registered via loops or computed paths are not caught.
//   - Sub-routers mounted with a prefix (`app.use("/api", sub)`) appear by
//     their inner path, not the full mounted URL.
//   - String paths only — template literals with interpolation are skipped.
//   - Only the first `Bun.serve({...})` call in a file is inspected.

import type { FunctionRoute, RouteMethod } from '@shared/types';

const SUPPORTED_METHODS: ReadonlySet<RouteMethod> = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
]);
const ROUTE_LIMIT = 50;
const SOURCE_FILE_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/i;

// `\b<ident>\.<verb>\s*\(\s*("path"|'path'|`path`)`. Path must start with `/`
// to avoid matching things like `headers.get("Authorization")` or
// `cache.get("user:42")`.
const ROUTE_CALL_RE =
  /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*\(\s*(['"`])(\/[^'"`]*)\2/g;

const BUN_SERVE_RE = /\bBun\s*\.\s*serve\s*\(\s*\{/;
const ROUTES_KEY_RE = /\broutes\s*:\s*\{/;
const PATH_ENTRY_RE = /(['"`])(\/[^'"`]*)\1\s*:\s*(\{)?/g;
const METHOD_KEY_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s*:/g;

export function extractRoutes(source: Record<string, string>): FunctionRoute[] | undefined {
  const out: FunctionRoute[] = [];
  const seen = new Set<string>();

  // Returns true when the limit is reached and the caller should bail out.
  const push = (route: FunctionRoute): boolean => {
    if (!SUPPORTED_METHODS.has(route.method)) return false;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(route);
    return out.length >= ROUTE_LIMIT;
  };

  for (const [name, content] of Object.entries(source)) {
    if (!SOURCE_FILE_RE.test(name)) continue;
    const stripped = stripComments(content);

    ROUTE_CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_CALL_RE.exec(stripped))) {
      const verb = match[1];
      const path = match[3];
      if (!verb || !path) continue;
      const method = verb.toUpperCase() as RouteMethod;
      if (push({ method, path })) return out;
    }

    for (const route of extractBunServeRoutes(stripped)) {
      if (push(route)) return out;
    }
  }

  return out.length > 0 ? out : undefined;
}

// Walks `Bun.serve({ ..., routes: { ... } })` and emits one route per top-level
// path entry. Method-keyed object values produce one route per method; any
// other value shape (function, Response, etc.) defaults to GET.
function extractBunServeRoutes(source: string): FunctionRoute[] {
  const body = findBunServeRoutesBody(source);
  if (!body) return [];

  const out: FunctionRoute[] = [];
  PATH_ENTRY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_ENTRY_RE.exec(body))) {
    const path = m[2];
    if (!path) continue;
    const opensBrace = m[3] === '{';

    if (opensBrace) {
      const braceIdx = m.index + m[0].length - 1;
      const block = readBalancedBlock(body, braceIdx);
      if (block) {
        const methods = extractMethodKeys(block.content);
        if (methods.length > 0) {
          for (const method of methods) out.push({ method, path });
        } else {
          out.push({ method: 'GET', path });
        }
        PATH_ENTRY_RE.lastIndex = block.end;
        continue;
      }
    }
    out.push({ method: 'GET', path });
  }
  return out;
}

function findBunServeRoutesBody(src: string): string | null {
  const callMatch = BUN_SERVE_RE.exec(src);
  if (!callMatch) return null;
  const optsBraceIdx = src.indexOf('{', callMatch.index);
  if (optsBraceIdx < 0) return null;
  const opts = readBalancedBlock(src, optsBraceIdx);
  if (!opts) return null;

  ROUTES_KEY_RE.lastIndex = 0;
  const routesKeyMatch = ROUTES_KEY_RE.exec(opts.content);
  if (!routesKeyMatch) return null;
  const routesBraceIdx = opts.content.indexOf('{', routesKeyMatch.index);
  if (routesBraceIdx < 0) return null;
  const routes = readBalancedBlock(opts.content, routesBraceIdx);
  return routes?.content ?? null;
}

// Reads a `{...}` block starting at `start` (must point at `{`). Skips braces
// inside string and template literals so `"{"` doesn't confuse the depth
// counter. Returns the content (excluding the outer braces) and the index
// just past the matching `}`.
function readBalancedBlock(src: string, start: number): { content: string; end: number } | null {
  if (src[start] !== '{') return null;
  let depth = 1;
  let i = start + 1;
  let inStr: string | null = null;
  let esc = false;
  while (i < src.length) {
    const ch = src[i];
    if (esc) {
      esc = false;
      i++;
      continue;
    }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

function extractMethodKeys(objBody: string): RouteMethod[] {
  const out: RouteMethod[] = [];
  const seen = new Set<RouteMethod>();
  METHOD_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_KEY_RE.exec(objBody))) {
    const verb = m[1];
    if (!verb) continue;
    const method = verb as RouteMethod;
    if (seen.has(method)) continue;
    seen.add(method);
    out.push(method);
  }
  return out;
}

// Strip block + line comments so commented-out routes don't pollute the list.
// Naive — doesn't track string state — but the worst case is that a `//`
// inside a string truncates that line, which would only ever cause a missed
// detection, never a false positive (since route registrations don't contain
// raw `//`).
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
