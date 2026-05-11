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

// `await (c.req|req).json()` — covers Hono's `c.req.json()` and Bun.serve's
// `req.json()`. We only care that the call exists; the LHS of the
// declaration tells us how the parsed body is used.
const JSON_CALL_PATTERN = String.raw`await\s+(?:c\.req|req)\.json\s*\(\s*\)`;
// `const { foo, bar } = await c.req.json()` — captures the keys.
const DESTRUCTURE_JSON_RE = new RegExp(
  String.raw`(?:const|let|var)\s*\{\s*([^}]+?)\s*\}\s*=\s*` + JSON_CALL_PATTERN,
  'g',
);
// `const body = await c.req.json()` — captures the alias.
const ALIAS_JSON_RE = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*` + JSON_CALL_PATTERN,
  'g',
);
const BODY_METHODS: ReadonlySet<RouteMethod> = new Set(['POST', 'PUT', 'PATCH']);

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
      const body = BODY_METHODS.has(method)
        ? extractHandlerBodyShape(stripped, match.index + match[0].length)
        : undefined;
      if (push(body ? { method, path, body } : { method, path })) return out;
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
          for (const method of methods) {
            const shape = BODY_METHODS.has(method)
              ? bunServeMethodHandlerBodyShape(block.content, method)
              : undefined;
            out.push(shape ? { method, path, body: shape } : { method, path });
          }
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

// Returns a `{key: "..."}` object derived from how the handler reads the
// request body. `startAfterPath` points just past the closing quote of the
// route path; we advance to the function-body `{`, read the balanced block,
// and scan it for destructured/aliased `c.req.json()` results.
function extractHandlerBodyShape(
  source: string,
  startAfterPath: number,
): Record<string, unknown> | undefined {
  // Advance past whitespace and the `,` separating path from handler.
  let i = startAfterPath;
  while (i < source.length && /\s/.test(source[i] ?? '')) i++;
  if (source[i] !== ',') return undefined;
  i++;
  while (i < source.length && /\s/.test(source[i] ?? '')) i++;

  // Find the body brace. Handler shapes we care about:
  //   async (c) => { ... }, (c) => { ... }, function (c) { ... }, function f(c) { ... }
  // For all of these the next `{` after the parameter list opens the block.
  // We search forward but bail if we hit a `;` or `)` outside a balanced
  // construct, to avoid pulling in unrelated code.
  const bodyStart = findHandlerBraceIndex(source, i);
  if (bodyStart < 0) return undefined;
  const block = readBalancedBlock(source, bodyStart);
  if (!block) return undefined;

  return bodyKeysFromHandler(block.content);
}

// Same idea, but the source we're scanning is the Bun.serve `{ GET: ..., POST: ... }`
// object body, and we want the handler attached to a specific method key.
function bunServeMethodHandlerBodyShape(
  objBody: string,
  method: RouteMethod,
): Record<string, unknown> | undefined {
  const keyRe = new RegExp(String.raw`\b${method}\s*:`, 'g');
  const m = keyRe.exec(objBody);
  if (!m) return undefined;
  // After the colon, the value could be a function, arrow, or Response — we
  // only care about the function-body brace.
  const bodyStart = findHandlerBraceIndex(objBody, m.index + m[0].length);
  if (bodyStart < 0) return undefined;
  const block = readBalancedBlock(objBody, bodyStart);
  if (!block) return undefined;
  return bodyKeysFromHandler(block.content);
}

// Walks forward from `from` looking for the `{` that opens a function body.
// Skips over the parameter list (if any) via balanced-paren counting, then
// returns the index of the first `{`. Returns -1 if not found within a
// reasonable lookahead.
function findHandlerBraceIndex(src: string, from: number): number {
  const LOOKAHEAD = 400;
  const end = Math.min(src.length, from + LOOKAHEAD);
  let i = from;
  let parenDepth = 0;
  while (i < end) {
    const ch = src[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '{' && parenDepth === 0) return i;
    i++;
  }
  return -1;
}

// Matches `*.completions.create(` — the OpenAI/AkashML chat-completions
// call. Used to detect when a `messages` body key is the OpenAI chat shape
// (array of {role, content}) rather than an opaque string.
const COMPLETIONS_CREATE_RE = /\.completions\.create\s*\(/;

// Collects the body keys referenced inside a handler block. Looks for:
//   const { a, b: rename } = await c.req.json()  → ['a', 'b']
//   const body = await c.req.json(); body.prompt  → ['prompt']
// Returns undefined when no shape can be inferred. Keys that look like the
// canonical OpenAI `messages` field get an array-of-objects placeholder so
// the auto-generated curl example is a valid request, not a 400.
function bodyKeysFromHandler(handler: string): Record<string, unknown> | undefined {
  const keys = new Set<string>();

  DESTRUCTURE_JSON_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = DESTRUCTURE_JSON_RE.exec(handler))) {
    const list = dm[1] ?? '';
    // `{a, b: rename, ...rest}` — strip rest, take the identifier on the LHS
    // (key, not local name) of each entry. Renames look like `key: localName`.
    for (const entry of list.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith('...')) continue;
      const idMatch = trimmed.match(/^([A-Za-z_$][\w$]*)/);
      if (idMatch?.[1]) keys.add(idMatch[1]);
    }
  }

  ALIAS_JSON_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ALIAS_JSON_RE.exec(handler))) {
    const alias = am[1];
    if (!alias) continue;
    const esc = escapeRegex(alias);
    // Member-access form: `alias.<key>`.
    const memberRe = new RegExp(String.raw`\b` + esc + String.raw`\.([A-Za-z_$][\w$]*)`, 'g');
    let mm: RegExpExecArray | null;
    while ((mm = memberRe.exec(handler))) {
      const key = mm[1];
      if (key) keys.add(key);
    }
    // Destructure-from-alias form: `const { a, b } = alias` — common when
    // code does `const body = await c.req.json(); const { prompt } = body`.
    const destructureFromAliasRe = new RegExp(
      String.raw`(?:const|let|var)\s*\{\s*([^}]+?)\s*\}\s*=\s*` + esc + String.raw`\b`,
      'g',
    );
    let dam: RegExpExecArray | null;
    while ((dam = destructureFromAliasRe.exec(handler))) {
      const list = dam[1] ?? '';
      for (const entry of list.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed || trimmed.startsWith('...')) continue;
        const idMatch = trimmed.match(/^([A-Za-z_$][\w$]*)/);
        if (idMatch?.[1]) keys.add(idMatch[1]);
      }
    }
  }

  if (keys.size === 0) return undefined;
  const callsCompletions = COMPLETIONS_CREATE_RE.test(handler);
  const shape: Record<string, unknown> = {};
  for (const k of keys) {
    // `messages` forwarded to chat.completions.create is the OpenAI chat
    // shape — emit a runnable example so the curl tab doesn't suggest a
    // string. Any other key (or `messages` in a non-completions context)
    // falls back to the generic `"..."` placeholder.
    if (k === 'messages' && callsCompletions) {
      shape[k] = [{ role: 'user', content: 'Hello' }];
    } else {
      shape[k] = '...';
    }
  }
  return shape;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
