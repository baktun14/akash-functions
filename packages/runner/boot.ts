// Akash Functions runner — supervisor entry point.
//
// Owns one mutable child process and a poll loop. On a new versionId, stages
// the new source in /app.next, swaps it into /app, and respawns the child.
// Falls back to /app.lkg if the new code fails to start.
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
import { mkdir, rename, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const APP_DIR = '/app';
const STAGING_DIR = '/app.next';
const LKG_DIR = '/app.lkg';
const BROKEN_DIR = '/app.broken';

const POLL_MIN_MS = 3_000;
const POLL_MAX_MS = 60_000;
const POLL_DEFAULT_MS = 10_000;
const KILL_GRACE_MS = 5_000;
const HEALTH_CHECK_MS = 5_000;

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
const authHeader = { Authorization: `Bearer ${RUNNER_TOKEN}` };

type ChildHandle = ReturnType<typeof Bun.spawn>;

let currentChild: ChildHandle | null = null;
let currentVersion = INITIAL_VERSION_ID;
let reloading = false;
let shuttingDown = false;

// ─── boot ───

console.log(`[boot] FUNCTION_ID=${FUNCTION_ID} initialVersion=${INITIAL_VERSION_ID} pollMs=${POLL_INTERVAL_MS}`);

await fetchAndExtract(INITIAL_VERSION_ID, APP_DIR);
await bunInstallIfNeeded(APP_DIR);
currentChild = spawnChild(APP_DIR);
attachExitWatcher(currentChild);

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
  try {
    await rm(STAGING_DIR, { recursive: true, force: true });
    await fetchAndExtract(newVersionId, STAGING_DIR);

    const installNeeded = await packageJsonChanged(APP_DIR, STAGING_DIR);
    if (installNeeded) {
      await bunInstall(STAGING_DIR);
    }

    // Atomic-ish swap: keep last-known-good in /app.lkg in case the new code
    // fails its health check.
    await rm(LKG_DIR, { recursive: true, force: true });
    await rename(APP_DIR, LKG_DIR);
    await rename(STAGING_DIR, APP_DIR);

    const oldChild = currentChild;
    currentChild = null; // tell the exit watcher the upcoming exit is expected
    if (oldChild) await terminateChild(oldChild);

    const next = spawnChild(APP_DIR);
    currentChild = next;
    attachExitWatcher(next);

    // Track the new version regardless of health-check outcome, so we don't
    // re-attempt the same broken version on every poll.
    currentVersion = newVersionId;

    const healthy = await waitForListening(PORT, HEALTH_CHECK_MS);
    if (!healthy) {
      console.error('[reload] health check failed, rolling back to last-known-good');
      await rollbackToLkg();
    } else {
      console.log(`[reload] live on ${newVersionId}`);
    }
  } catch (err) {
    console.error(`[reload] failed: ${(err as Error).message}`);
    // Don't kill the running child; a bad fetch / install should leave the
    // pod serving its current version.
    await rm(STAGING_DIR, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    reloading = false;
  }
}

async function rollbackToLkg(): Promise<void> {
  if (!existsSync(LKG_DIR)) {
    console.error('[rollback] no /app.lkg to restore from');
    return;
  }
  const broken = currentChild;
  currentChild = null;
  if (broken) await terminateChild(broken);

  await rm(BROKEN_DIR, { recursive: true, force: true });
  await rename(APP_DIR, BROKEN_DIR);
  await rename(LKG_DIR, APP_DIR);

  const restored = spawnChild(APP_DIR);
  currentChild = restored;
  attachExitWatcher(restored);
  console.log('[rollback] restored last-known-good /app');
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

const ENTRY_CANDIDATES = ['/src/index.ts', '/index.ts', '/src/index.tsx', '/index.tsx'];

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
