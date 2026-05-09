// Akash Functions runner — supervisor entry point.
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
// Required env vars (injected by the SDL at deploy time):
//   FUNCTION_ID         opaque function identifier
//   INITIAL_VERSION_ID  version to fetch on first boot
//   BACKEND_BASE_URL    e.g. https://api.example.com (no path)
//   RUNNER_TOKEN        long-lived runner-kind HMAC, scoped to FUNCTION_ID
//   PORT                port the user code listens on (default 3000)
//   POLL_INTERVAL_MS    runner version poll cadence (default 10000, range [3000, 60000])
//   AKASHML_API_KEY     (optional) passthrough to user code

import { connect } from 'node:net';
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

// Must be declared before the top-level `await` below, otherwise spawnChild
// (called at boot) reaches it through the TDZ and crashes the runner with
// "Cannot access 'ENTRY_CANDIDATES' before initialization".
const ENTRY_CANDIDATES = ['/src/index.ts', '/index.ts', '/src/index.tsx', '/index.tsx'];

const env = process.env;
const FUNCTION_ID = env.FUNCTION_ID;
const INITIAL_VERSION_ID = env.INITIAL_VERSION_ID;
const BACKEND_BASE_URL = env.BACKEND_BASE_URL?.replace(/\/$/, '');
const RUNNER_TOKEN = env.RUNNER_TOKEN;
const PORT = Number(env.PORT ?? '3000');
const POLL_INTERVAL_MS = clampPoll(Number(env.POLL_INTERVAL_MS ?? POLL_DEFAULT_MS));

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
const currentUrl = `${BACKEND_BASE_URL}/api/runner/current/${FUNCTION_ID}`;
const healthUrl = `${BACKEND_BASE_URL}/api/runner/health/${FUNCTION_ID}`;
const authHeader = { Authorization: `Bearer ${RUNNER_TOKEN}` };

type ProbeResult =
  | { kind: 'ok'; status: number }
  | { kind: 'http-error'; status: number; statusText: string; bodyExcerpt: string }
  | { kind: 'connect-error'; reason: string };

type ChildHandle = ReturnType<typeof Bun.spawn>;

let currentChild: ChildHandle | null = null;
let currentVersion = INITIAL_VERSION_ID;
let reloading = false;
let shuttingDown = false;

// ─── boot ───

console.log(`[boot] FUNCTION_ID=${FUNCTION_ID} initialVersion=${INITIAL_VERSION_ID} pollMs=${POLL_INTERVAL_MS}`);

await prepareAppDir();
await mkdir(VERSIONS_DIR, { recursive: true });
const initialDir = versionDir(INITIAL_VERSION_ID);
await rm(initialDir, { recursive: true, force: true });
await fetchAndExtract(INITIAL_VERSION_ID, initialDir);
await bunInstallIfNeeded(initialDir);
await swapCurrentSymlink(initialDir);
currentChild = spawnChild(CURRENT_LINK);
attachExitWatcher(currentChild);

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
    try {
      const next = await fetchCurrentVersion();
      if (next && next !== currentVersion && !reloading) {
        await reload(next);
      }
    } catch (err) {
      console.warn(`[poll] error: ${(err as Error).message}`);
    }
  }
}

async function fetchCurrentVersion(): Promise<string | null> {
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
  const body = (await res.json()) as { versionId?: string };
  return body.versionId ?? null;
}

async function reload(newVersionId: string): Promise<void> {
  if (reloading) return;
  reloading = true;
  console.log(`[reload] swapping ${currentVersion} → ${newVersionId}`);
  const previousVersion = currentVersion;
  try {
    const newDir = versionDir(newVersionId);
    await rm(newDir, { recursive: true, force: true });
    await fetchAndExtract(newVersionId, newDir);

    if (await packageJsonChanged(versionDir(previousVersion), newDir)) {
      await bunInstall(newDir);
    }

    await swapCurrentSymlink(newDir);

    const oldChild = currentChild;
    currentChild = null; // tell the exit watcher the upcoming exit is expected
    if (oldChild) await terminateChild(oldChild);

    const next = spawnChild(CURRENT_LINK);
    currentChild = next;
    attachExitWatcher(next);

    // Track the new version regardless of health-check outcome, so we don't
    // re-attempt the same broken version on every poll.
    currentVersion = newVersionId;

    const tcpHealthy = await waitForListening(PORT, HEALTH_CHECK_MS);
    if (!tcpHealthy) {
      console.error('[reload] tcp health check failed, rolling back');
      await reportHealth(newVersionId, { kind: 'connect-error', reason: 'listen timeout' });
      await rollbackToVersion(previousVersion);
      return;
    }

    const probe = await httpProbe(PORT, HTTP_PROBE_MS);
    await reportHealth(newVersionId, probe);
    if (probe.kind !== 'ok') {
      console.error(`[reload] http probe ${probe.kind === 'http-error' ? `${probe.status} ${probe.statusText}` : `connect ${probe.reason}`}, rolling back`);
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
  console.log(`[spawn] bun ${entry} on port ${PORT}`);
  return Bun.spawn(['bun', entry], {
    cwd: dir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PORT: String(PORT) },
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
  const tcpHealthy = await waitForListening(PORT, HEALTH_CHECK_MS);
  if (!tcpHealthy) {
    await reportHealth(versionId, { kind: 'connect-error', reason: 'listen timeout' });
    return;
  }
  const probe = await httpProbe(PORT, HTTP_PROBE_MS);
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
