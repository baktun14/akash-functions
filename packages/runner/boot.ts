// Akash Functions runner — supervisor + reverse proxy.
//
// Owns one mutable child process and a poll loop. Each version's source lives
// under /app/versions/<id>/ and /app/current is a relative symlink into that
// directory. Reloads extract the new version, atomically swap the symlink, and
// respawn the child against /app/current. On health-check failure, the symlink
// swaps back to the previous version's directory (still on disk).
//
// Keeping all reload state inside /app means every rename stays on a single
// filesystem regardless of how the provider mounts /app — sibling paths like
// /app.lkg would cross a mount boundary and fail with EXDEV.
//
// External traffic flow (with API-key auth):
//   provider ingress → runner :EXTERNAL_PORT → (auth check) → user code :USER_PORT
//
// The runner listens on the externally-visible PORT and forwards requests to
// the user code on a fixed internal USER_PORT after consulting the route /
// apiKeyHashes tables refreshed from /api/runner/current on every poll.
//
// Required env vars (injected by the SDL at deploy time):
//   FUNCTION_ID         opaque function identifier
//   INITIAL_VERSION_ID  version to fetch on first boot
//   BACKEND_BASE_URL    e.g. https://api.example.com (no path)
//   RUNNER_TOKEN        long-lived runner-kind HMAC, scoped to FUNCTION_ID
//   PORT                external port the runner listens on (default 3000).
//                       The user code is started on USER_PORT (3001) internally
//                       and is never reachable from outside the container.
//   POLL_INTERVAL_MS    runner version poll cadence (default 10000, range [3000, 60000])
//
// User-defined env vars (e.g. AKASHML_API_KEY, DATABASE_URL) are NOT in the
// SDL — the supervisor fetches them from /api/runner/env/:fnId at boot and
// whenever the poll loop sees variablesRevision change on /current/:fnId.
// The SDL is visible to providers and unsuitable for secrets.

import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';

const APP_DIR = '/app';
const VERSIONS_DIR = '/app/versions';
const CURRENT_LINK = '/app/current';
const STAGING_LINK = '/app/.current.next';

const POLL_MIN_MS = 3_000;
const POLL_MAX_MS = 60_000;
const POLL_DEFAULT_MS = 10_000;
const KILL_GRACE_MS = 5_000;
const HEALTH_CHECK_MS = 5_000;
const HTTP_PROBE_MS = 5_000;
const HTTP_PROBE_BODY_MAX = 1500;

// Boot-time env-fetch retry policy. Three attempts with exponential backoff
// (1s, 2s, 4s) — total max ~7s before we give up and exit non-zero so Akash
// restarts the pod. Failing closed at boot is correct because there's no
// previous-good env to fall back to; starting with a partial env would mean
// the user's first request hits a function with missing secrets, which is
// a worse failure mode than a clean restart-loop.
const ENV_BOOT_FETCH_ATTEMPTS = 3;
const ENV_BOOT_FETCH_BACKOFF_MS = 1_000;

// Must be declared before the top-level `await` below, otherwise spawnChild
// (called at boot) reaches it through the TDZ and crashes the runner with
// "Cannot access 'ENTRY_CANDIDATES' before initialization".
const ENTRY_CANDIDATES = ['/src/index.ts', '/index.ts', '/src/index.tsx', '/index.tsx'];

const env = process.env;
const FUNCTION_ID = env.FUNCTION_ID;
const INITIAL_VERSION_ID = env.INITIAL_VERSION_ID;
const BACKEND_BASE_URL = env.BACKEND_BASE_URL?.replace(/\/$/, '');
const RUNNER_TOKEN = env.RUNNER_TOKEN;
// External port the provider ingress hits. The runner's reverse proxy listens
// here and forwards to user code on USER_PORT after auth.
const EXTERNAL_PORT = Number(env.PORT ?? '3000');
// Fixed internal port the user code listens on. The runner spawns the child
// with PORT set to this value; the user code keeps using `process.env.PORT`
// and is unaware that PORT was rewritten.
const USER_PORT = 3001;
const POLL_INTERVAL_MS = clampPoll(Number(env.POLL_INTERVAL_MS ?? POLL_DEFAULT_MS));
// Reported on every /api/runner/current poll so the dashboard can flag
// deployments running an outdated runner and offer the in-place update flow.
// Bump in lockstep with packages/runner/package.json.
const RUNNER_VERSION = '2.1.0';

if (!FUNCTION_ID || !INITIAL_VERSION_ID || !BACKEND_BASE_URL || !RUNNER_TOKEN) {
  console.error('[boot] missing one of FUNCTION_ID, INITIAL_VERSION_ID, BACKEND_BASE_URL, RUNNER_TOKEN');
  process.exit(1);
}

function clampPoll(n: number): number {
  if (!Number.isFinite(n)) return POLL_DEFAULT_MS;
  return Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, Math.floor(n)));
}

const codeUrl = (versionId: string) =>
  `${BACKEND_BASE_URL}/api/runner/code/${FUNCTION_ID}/${versionId}`;
// Self-report version via query string — shows up in standard request logs,
// avoids CORS preflight concerns, and the backend just upserts it on the
// deployment row when it changes.
const currentUrl =
  `${BACKEND_BASE_URL}/api/runner/current/${FUNCTION_ID}?v=${encodeURIComponent(RUNNER_VERSION)}`;
const envUrl = `${BACKEND_BASE_URL}/api/runner/env/${FUNCTION_ID}`;
const healthUrl = `${BACKEND_BASE_URL}/api/runner/health/${FUNCTION_ID}`;
const authHeader = { Authorization: `Bearer ${RUNNER_TOKEN}` };

type ProbeResult =
  | { kind: 'ok'; status: number }
  | { kind: 'http-error'; status: number; statusText: string; bodyExcerpt: string }
  | { kind: 'connect-error'; reason: string };

type ChildHandle = ReturnType<typeof Bun.spawn>;

type RouteEntry = {
  method: string;
  // Compiled regex against the request pathname. ':param' segments match a
  // single non-slash path segment; everything else is matched literally.
  matcher: RegExp;
  protected: boolean;
};

// SDL-injected env (FUNCTION_ID, RUNNER_TOKEN, PATH, etc.). Frozen at boot —
// these are NOT user-controllable and must beat user vars on key collision.
const baseEnv: Record<string, string> = { ...process.env } as Record<string, string>;

let currentChild: ChildHandle | null = null;
let currentVersion = INITIAL_VERSION_ID;
let currentVarsRevision = -1;
let currentEnv: Record<string, string> = {};
let reloading = false;
let shuttingDown = false;
// Replaced wholesale on every successful poll. Empty until the first poll
// completes; until then, protected routes 401 — acceptable because the
// function isn't externally reachable before its lease is live anyway.
let routeTable: RouteEntry[] = [];
let apiKeyHashes: Set<string> = new Set();
// Hop-by-hop headers per RFC 7230. Stripped from both request and response so
// the upstream socket lifecycle doesn't bleed into the user's view of headers.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  // host: fetch() rewrites this; sending '127.0.0.1:USER_PORT' downstream
  // would surprise user code that inspects the Host header.
  'host',
  // content-length: regenerated by fetch() from the body stream.
  'content-length',
]);

// ─── boot ───

console.log(
  `[boot] FUNCTION_ID=${FUNCTION_ID} initialVersion=${INITIAL_VERSION_ID} ` +
    `external=${EXTERNAL_PORT} user=${USER_PORT} pollMs=${POLL_INTERVAL_MS}`
);

await prepareAppDir();
await mkdir(VERSIONS_DIR, { recursive: true });
const initialDir = versionDir(INITIAL_VERSION_ID);
await rm(initialDir, { recursive: true, force: true });

// Code fetch+install and env fetch are independent — only spawn requires both.
// Running them in parallel cuts cold-start by the smaller of the two.
// Fail-closed on env: no previous-good to fall back to here, so retry-then-exit
// is better than starting with a partial env on the user's first request.
const [, initialEnvFetch] = await Promise.all([
  (async () => {
    await fetchAndExtract(INITIAL_VERSION_ID, initialDir);
    await bunInstallIfNeeded(initialDir);
    await swapCurrentSymlink(initialDir);
  })(),
  fetchEnvWithRetries(),
]);
currentEnv = initialEnvFetch.env;
currentVarsRevision = initialEnvFetch.revision;

currentChild = spawnChild(CURRENT_LINK);
attachExitWatcher(currentChild);

// Reverse proxy on EXTERNAL_PORT — the only thing the provider ingress reaches.
// Returns 503 until the user code is listening; once up, forwards every request
// to USER_PORT after consulting routeTable + apiKeyHashes for protected routes.
startProxyServer();

// Best-effort first-request probe so the dashboard shows runtime errors
// (e.g. user code listens but throws on every request). No rollback path on
// initial boot — there's no previous version to fall back to.
void probeAndReport(INITIAL_VERSION_ID);

process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));

// Background poll loop. Errors here must never crash the supervisor — keep the
// running child alive and try again next interval.
void pollLoop();

// ─── implementation ───

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    await sleep(POLL_INTERVAL_MS);
    if (shuttingDown) return;
    if (reloading) continue;
    try {
      const next = await fetchCurrentPointer();
      if (!next) continue;
      if (next.versionId !== currentVersion) {
        // Code-version change subsumes any concurrent vars-revision change —
        // the post-reload state will be both new code + freshly-fetched env.
        await reload(next.versionId, next.variablesRevision);
      } else if (
        next.variablesRevision !== undefined &&
        next.variablesRevision !== currentVarsRevision
      ) {
        await reloadVarsOnly(next.variablesRevision);
      }
    } catch (err) {
      console.warn(`[poll] error: ${(err as Error).message}`);
    }
  }
}

type CurrentPointer = {
  versionId: string;
  /** Server may not yet emit this in older deployments — treat as unchanged. */
  variablesRevision?: number;
};

async function fetchCurrentPointer(): Promise<CurrentPointer | null> {
  const res = await fetch(currentUrl, { headers: authHeader });
  if (res.status === 404) {
    console.log('[poll] function deleted upstream, exiting cleanly');
    shuttingDown = true;
    setTimeout(() => process.exit(0), 100);
    return null;
  }
  if (res.status === 401) {
    console.error('[poll] 401 from /current — runner token rejected; keeping current child alive');
    return null;
  }
  if (!res.ok) {
    console.warn(`[poll] /current returned ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    versionId?: string;
    variablesRevision?: number;
    apiKeyHashes?: string[];
    routes?: Array<{ method: string; path: string; auth?: string }>;
  };
  // Refresh proxy auth state on every successful poll. Failures keep the last
  // known set rather than flipping every protected route to 401.
  if (Array.isArray(body.apiKeyHashes)) {
    apiKeyHashes = new Set(body.apiKeyHashes);
  }
  if (Array.isArray(body.routes)) {
    routeTable = compileRouteTable(body.routes);
  }
  if (!body.versionId) return null;
  return {
    versionId: body.versionId,
    variablesRevision:
      typeof body.variablesRevision === 'number' ? body.variablesRevision : undefined,
  };
}

function compileRouteTable(
  raw: Array<{ method: string; path: string; auth?: string }>
): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const r of raw) {
    if (typeof r?.method !== 'string' || typeof r?.path !== 'string') continue;
    if (!r.path.startsWith('/')) continue;
    const matcher = pathToRegex(r.path);
    if (!matcher) continue;
    out.push({
      method: r.method.toUpperCase(),
      matcher,
      protected: r.auth === 'apiKey',
    });
  }
  return out;
}

// Express/Hono-style path pattern → regex anchored to the full pathname.
// ':param' segments match a single non-slash segment; everything else is
// matched literally with regex metacharacters escaped.
function pathToRegex(pattern: string): RegExp | null {
  const segments = pattern.split('/');
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg === '') {
      parts.push('');
      continue;
    }
    if (seg.startsWith(':')) {
      parts.push('[^/]+');
      continue;
    }
    parts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  try {
    return new RegExp('^' + parts.join('/') + '$');
  } catch {
    return null;
  }
}

function findMatchingRoute(method: string, pathname: string): RouteEntry | null {
  for (const r of routeTable) {
    if (r.method !== method) continue;
    if (r.matcher.test(pathname)) return r;
  }
  return null;
}

function extractApiKey(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const match = /^bearer\s+(.+)$/i.exec(auth);
    if (match && match[1]) return match[1].trim();
  }
  const xKey = req.headers.get('x-api-key');
  return xKey ? xKey.trim() : null;
}

function isValidApiKey(plaintext: string): boolean {
  if (apiKeyHashes.size === 0) return false;
  const candidate = createHash('sha256').update(plaintext).digest('hex');
  // Constant-time equality across the whole hash set: scanning every entry
  // avoids leaking whether *any* hash exists with a given prefix via timing.
  // The set has O(keys) entries (typically <10), so the cost is negligible.
  let matched = false;
  for (const stored of apiKeyHashes) {
    if (timingSafeStringEqual(stored, candidate)) matched = true;
  }
  return matched;
}

// Constant-time string comparison. Uses charCodeAt + bitwise XOR to scan the
// full string regardless of the first mismatch index, which is what
// node:crypto.timingSafeEqual gives us for buffers. Both inputs must be the
// same length; for fixed-length hex digests they always are (64 chars).
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function unauthorizedResponse(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 'UNAUTHORIZED', message } }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="akash-functions"',
        'cache-control': 'no-store',
      },
    }
  );
}

function startProxyServer(): void {
  Bun.serve({
    port: EXTERNAL_PORT,
    // Akash Functions can serve large request bodies (file uploads, etc.).
    // 50MB cap balances reasonable use against memory pressure on the runner.
    maxRequestBodySize: 50 * 1024 * 1024,
    fetch: handleProxyRequest,
    error(err: Error) {
      console.warn(`[proxy] error: ${err.message}`);
      return new Response('Bad Gateway', { status: 502 });
    },
  });
  console.log(`[proxy] listening on :${EXTERNAL_PORT} → 127.0.0.1:${USER_PORT}`);
}

async function handleProxyRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // CORS preflight: forward without auth so the browser can complete the
  // handshake and then send the real (auth-bearing) request.
  if (method !== 'OPTIONS') {
    const route = findMatchingRoute(method, url.pathname);
    if (route?.protected) {
      const key = extractApiKey(req);
      if (!key) {
        return unauthorizedResponse('Missing API key');
      }
      if (!isValidApiKey(key)) {
        return unauthorizedResponse('Invalid API key');
      }
    }
  }

  if (!currentChild || reloading) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Function is restarting' } }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '1',
          'cache-control': 'no-store',
        },
      }
    );
  }

  const upstream = new URL(url.pathname + url.search, `http://127.0.0.1:${USER_PORT}`);
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }

  try {
    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: methodAllowsBody(method) ? req.body : undefined,
      // @ts-expect-error duplex required by undici/Bun for streaming bodies
      duplex: 'half',
      redirect: 'manual',
    });
    const respHeaders = new Headers();
    for (const [name, value] of upstreamRes.headers) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      respHeaders.set(name, value);
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'BAD_GATEWAY',
          message: `Upstream unreachable: ${(err as Error).message}`,
        },
      }),
      {
        status: 502,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }
    );
  }
}

function methodAllowsBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

type EnvFetchResult = { env: Record<string, string>; revision: number };

async function fetchEnv(): Promise<EnvFetchResult> {
  const res = await fetch(envUrl, { headers: authHeader });
  if (!res.ok) {
    throw new Error(`/env fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    env?: Record<string, string>;
    variablesRevision?: number;
  };
  return {
    env: body.env ?? {},
    revision: typeof body.variablesRevision === 'number' ? body.variablesRevision : 0,
  };
}

async function fetchEnvWithRetries(): Promise<EnvFetchResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ENV_BOOT_FETCH_ATTEMPTS; attempt++) {
    try {
      const result = await fetchEnv();
      const keyCount = Object.keys(result.env).length;
      console.log(`[boot] fetched env: ${keyCount} keys, revision=${result.revision}`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[boot] env fetch attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt < ENV_BOOT_FETCH_ATTEMPTS) {
        // 1s, 2s, 4s — total ≤ 7s before we give up.
        await sleep(ENV_BOOT_FETCH_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }
  console.error(`[boot] env fetch failed after ${ENV_BOOT_FETCH_ATTEMPTS} attempts; exiting`);
  throw lastErr instanceof Error ? lastErr : new Error('env fetch exhausted retries');
}

async function reload(newVersionId: string, newVarsRevision?: number): Promise<void> {
  if (reloading) return;
  reloading = true;
  console.log(`[reload] swapping ${currentVersion} → ${newVersionId}`);
  const previousVersion = currentVersion;
  const previousEnv = currentEnv;
  const previousRevision = currentVarsRevision;
  try {
    const newDir = versionDir(newVersionId);
    await rm(newDir, { recursive: true, force: true });
    await fetchAndExtract(newVersionId, newDir);

    if (await packageJsonChanged(versionDir(previousVersion), newDir)) {
      await bunInstall(newDir);
    }

    await swapCurrentSymlink(newDir);

    // Re-fetch env if the server signalled a vars change alongside this code
    // change, or if it wasn't tracked before. Failure here keeps the previous
    // env (fail-open at runtime — boot is the only place we fail-closed).
    if (newVarsRevision !== undefined && newVarsRevision !== currentVarsRevision) {
      try {
        const fresh = await fetchEnv();
        currentEnv = fresh.env;
        currentVarsRevision = fresh.revision;
      } catch (err) {
        console.warn(`[reload] env refetch failed; keeping previous env: ${(err as Error).message}`);
      }
    }

    const oldChild = currentChild;
    currentChild = null; // tell the exit watcher the upcoming exit is expected
    if (oldChild) await terminateChild(oldChild);

    const next = spawnChild(CURRENT_LINK);
    currentChild = next;
    attachExitWatcher(next);

    // Track the new version regardless of health-check outcome, so we don't
    // re-attempt the same broken version on every poll.
    currentVersion = newVersionId;

    const tcpHealthy = await waitForListening(USER_PORT, HEALTH_CHECK_MS);
    if (!tcpHealthy) {
      console.error('[reload] tcp health check failed, rolling back');
      await reportHealth(newVersionId, { kind: 'connect-error', reason: 'listen timeout' });
      currentEnv = previousEnv;
      currentVarsRevision = previousRevision;
      await rollbackToVersion(previousVersion);
      return;
    }

    const probe = await httpProbe(USER_PORT, HTTP_PROBE_MS);
    await reportHealth(newVersionId, probe);
    if (probe.kind !== 'ok') {
      console.error(`[reload] http probe ${probe.kind === 'http-error' ? `${probe.status} ${probe.statusText}` : `connect ${probe.reason}`}, rolling back`);
      currentEnv = previousEnv;
      currentVarsRevision = previousRevision;
      await rollbackToVersion(previousVersion);
      return;
    }

    console.log(`[reload] live on ${newVersionId}`);
    await pruneOldVersions(new Set([newVersionId, previousVersion]));
  } catch (err) {
    console.error(`[reload] failed: ${(err as Error).message}`);
    // Don't kill the running child; a bad fetch / install should leave the
    // pod serving its current version.
    await rm(versionDir(newVersionId), { recursive: true, force: true }).catch(() => undefined);
  } finally {
    reloading = false;
  }
}

// Variables-only reload: same restart shape as `reload`, but skips the code
// fetch/install/symlink swap. Fail-open at runtime — if the env fetch errors,
// the running child keeps serving with stale env until the next poll. We
// still respawn on a successful env fetch so user code that captures
// `process.env.X` once at startup picks up the new value.
async function reloadVarsOnly(newRevision: number): Promise<void> {
  if (reloading) return;
  reloading = true;
  console.log(`[vars-reload] revision ${currentVarsRevision} → ${newRevision}`);
  const previousEnv = currentEnv;
  const previousRevision = currentVarsRevision;
  try {
    const fresh = await fetchEnv();
    currentEnv = fresh.env;
    currentVarsRevision = fresh.revision;

    const oldChild = currentChild;
    currentChild = null;
    if (oldChild) await terminateChild(oldChild);

    const next = spawnChild(CURRENT_LINK);
    currentChild = next;
    attachExitWatcher(next);

    const tcpHealthy = await waitForListening(USER_PORT, HEALTH_CHECK_MS);
    if (!tcpHealthy) {
      console.error('[vars-reload] tcp health check failed, reverting env');
      await reportHealth(currentVersion, { kind: 'connect-error', reason: 'vars-reload listen timeout' });
      currentEnv = previousEnv;
      currentVarsRevision = previousRevision;
      await respawnChildWithCurrentEnv();
      return;
    }

    const probe = await httpProbe(USER_PORT, HTTP_PROBE_MS);
    await reportHealth(currentVersion, probe);
    if (probe.kind !== 'ok') {
      console.error(`[vars-reload] http probe failed (${probe.kind}); reverting env`);
      currentEnv = previousEnv;
      currentVarsRevision = previousRevision;
      await respawnChildWithCurrentEnv();
      return;
    }

    console.log(`[vars-reload] live with revision ${newRevision}`);
  } catch (err) {
    // fetchEnv() failure: keep the running child alive with stale env.
    console.error(`[vars-reload] failed: ${(err as Error).message}; keeping previous env`);
  } finally {
    reloading = false;
  }
}

async function respawnChildWithCurrentEnv(): Promise<void> {
  const broken = currentChild;
  currentChild = null;
  if (broken) await terminateChild(broken);
  const restored = spawnChild(CURRENT_LINK);
  currentChild = restored;
  attachExitWatcher(restored);
}

async function rollbackToVersion(versionId: string): Promise<void> {
  const dir = versionDir(versionId);
  if (!existsSync(dir)) {
    console.error(`[rollback] versions/${versionId} missing, cannot rollback`);
    return;
  }
  const broken = currentChild;
  currentChild = null;
  if (broken) await terminateChild(broken);

  await swapCurrentSymlink(dir);
  currentVersion = versionId;

  const restored = spawnChild(CURRENT_LINK);
  currentChild = restored;
  attachExitWatcher(restored);
  console.log(`[rollback] restored ${versionId}`);
  // Re-probe the restored version so the dashboard's runtime warning clears
  // when the previous-good version still serves cleanly.
  void probeAndReport(versionId);
}

async function fetchAndExtract(versionId: string, dest: string): Promise<void> {
  console.log(`[fetch] ${codeUrl(versionId)} → ${dest}`);
  await mkdir(dest, { recursive: true });

  const res = await fetch(codeUrl(versionId), { headers: authHeader });
  if (!res.ok) {
    throw new Error(`code fetch ${versionId} failed: ${res.status} ${res.statusText}`);
  }

  const tar = Bun.spawn(['tar', '-xz', '-C', dest], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('code fetch returned empty body');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tar.stdin.write(value);
  }
  await tar.stdin.end();
  const exit = await tar.exited;
  if (exit !== 0) throw new Error(`tar exited with ${exit}`);
}

async function bunInstallIfNeeded(dir: string): Promise<void> {
  const pkg = Bun.file(`${dir}/package.json`);
  if (!(await pkg.exists())) return;
  await bunInstall(dir);
}

async function bunInstall(dir: string): Promise<void> {
  console.log(`[install] bun install in ${dir}`);
  const proc = Bun.spawn(['bun', 'install', '--production'], {
    cwd: dir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`bun install exited with ${exit}`);
}

async function packageJsonChanged(oldDir: string, newDir: string): Promise<boolean> {
  const oldPath = `${oldDir}/package.json`;
  const newPath = `${newDir}/package.json`;
  const newExists = existsSync(newPath);
  if (!newExists) return false;
  if (!existsSync(oldPath)) return true;
  try {
    const [a, b] = await Promise.all([readFile(oldPath, 'utf8'), readFile(newPath, 'utf8')]);
    return a !== b;
  } catch {
    return true;
  }
}

function versionDir(id: string): string {
  return `${VERSIONS_DIR}/${id}`;
}

async function prepareAppDir(): Promise<void> {
  await mkdir(APP_DIR, { recursive: true });
  // Clear stale top-level entries from any previous container life. Skip the
  // dirs we own so a warm restart keeps existing version data.
  const entries = await readdir(APP_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry === 'versions' || entry === 'current') continue;
    await rm(`${APP_DIR}/${entry}`, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function swapCurrentSymlink(targetDir: string): Promise<void> {
  // Relative target so the symlink stays valid no matter how /app is mounted.
  const rel = relative(APP_DIR, targetDir);
  await rm(STAGING_LINK, { force: true }).catch(() => undefined);
  await symlink(rel, STAGING_LINK);
  await rename(STAGING_LINK, CURRENT_LINK);
}

async function pruneOldVersions(keep: Set<string>): Promise<void> {
  const entries = await readdir(VERSIONS_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    await rm(`${VERSIONS_DIR}/${entry}`, { recursive: true, force: true }).catch(() => undefined);
  }
}

function pickEntry(dir: string): string | undefined {
  for (const rel of ENTRY_CANDIDATES) {
    const full = `${dir}${rel}`;
    if (existsSync(full)) return full;
  }
  return undefined;
}

function spawnChild(dir: string): ChildHandle {
  const entry = pickEntry(dir);
  if (!entry) {
    throw new Error(`no entry point found in ${dir}; tried ${ENTRY_CANDIDATES.join(', ')}`);
  }
  console.log(`[spawn] bun --preload /boot/preload.ts ${entry} on port ${USER_PORT}`);
  // Merge order matters: user vars first, then SDL-injected baseEnv, then
  // PORT. Later spreads win, so SDL system vars (FUNCTION_ID, RUNNER_TOKEN,
  // BACKEND_BASE_URL, …) and PORT cannot be shadowed by anything a user
  // managed to slip into function_variables. This is defense-in-depth on top
  // of the API/DB-layer reserved-key check. PORT is rewritten to USER_PORT so
  // user code listens on the internal port; the runner's proxy on
  // EXTERNAL_PORT is the only thing the outside world reaches.
  //
  // --preload rewrites Bun.serve port args to PORT so legacy user code with
  // a hardcoded `port: 3000` doesn't collide with the runner on 3000.
  return Bun.spawn(['bun', '--preload', '/boot/preload.ts', entry], {
    cwd: dir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...currentEnv, ...baseEnv, PORT: String(USER_PORT) },
  });
}

function attachExitWatcher(child: ChildHandle): void {
  void (async () => {
    const code = await child.exited;
    // If currentChild was nulled by reload/rollback, this exit is expected.
    if (shuttingDown || currentChild !== child) return;
    console.error(`[child] exited unexpectedly with code ${code}, propagating`);
    process.exit(code ?? 1);
  })();
}

async function terminateChild(child: ChildHandle): Promise<void> {
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  try {
    await child.exited;
  } finally {
    clearTimeout(killTimer);
  }
}

function forwardSignal(sig: 'SIGTERM' | 'SIGINT'): void {
  shuttingDown = true;
  console.log(`[boot] forwarding ${sig}`);
  if (currentChild) {
    try { currentChild.kill(sig); } catch { /* already gone */ }
  }
}

// One-shot HTTP GET / against the user code. The TCP probe in waitForListening
// only proves the port is bound; this proves the fetch handler actually
// responds without a 5xx. 4xx is treated as healthy — many user functions
// 404 on `/` because they only mount specific routes.
async function httpProbe(port: number, deadlineMs: number): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'akash-fn-runner-probe' },
    });
    if (res.status >= 500) {
      const bodyExcerpt = await readExcerpt(res, HTTP_PROBE_BODY_MAX);
      return { kind: 'http-error', status: res.status, statusText: res.statusText, bodyExcerpt };
    }
    await res.body?.cancel().catch(() => undefined);
    return { kind: 'ok', status: res.status };
  } catch (err) {
    return { kind: 'connect-error', reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function readExcerpt(res: Response, max: number): Promise<string> {
  try {
    const text = await res.text();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return '';
  }
}

// Fire-and-forget. Health reporting must never block boot/reload, and a
// transient backend failure should not affect the running child.
async function reportHealth(versionId: string, probe: ProbeResult): Promise<void> {
  const payload =
    probe.kind === 'ok'
      ? { ok: true, versionId, status: probe.status }
      : probe.kind === 'http-error'
        ? {
            ok: false,
            versionId,
            status: probe.status,
            statusText: probe.statusText,
            bodyExcerpt: probe.bodyExcerpt,
          }
        : { ok: false, versionId, status: 0, reason: probe.reason };
  try {
    const res = await fetch(healthUrl, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[health] report ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[health] report failed: ${(err as Error).message}`);
  }
}

async function probeAndReport(versionId: string): Promise<void> {
  const tcpHealthy = await waitForListening(USER_PORT, HEALTH_CHECK_MS);
  if (!tcpHealthy) {
    await reportHealth(versionId, { kind: 'connect-error', reason: 'listen timeout' });
    return;
  }
  const probe = await httpProbe(USER_PORT, HTTP_PROBE_MS);
  await reportHealth(versionId, probe);
  if (probe.kind !== 'ok') {
    console.warn(`[health] ${probe.kind === 'http-error' ? `${probe.status} ${probe.statusText}` : `connect ${probe.reason}`}`);
  }
}

function waitForListening(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() >= deadline) return resolve(false);
      const sock = connect({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
