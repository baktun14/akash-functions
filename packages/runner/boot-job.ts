// Akash Functions runner — job mode (run-to-completion supervisor).
//
// Service mode (boot.ts) owns a long-lived child + reverse proxy and hot-reloads
// on version changes. Job mode is the opposite shape: fetch the user source ONCE
// (jobs are immutable — no version reloads), run a Python script to completion,
// stream its stdout/stderr to the backend, capture the exit code, report it via
// /complete, then IDLE forever.
//
// Why idle instead of exit: this image runs under Akash k8s with
// restartPolicy=Always. If we exit(0) on success the pod would just re-run
// main.py in a loop. So after /complete we keep heartbeating /current and only
// exit(0) once the lease is torn down server-side (the next /current returns
// 404). The server tears the lease down within seconds of /complete.
//
// This module imports boot.ts ONLY for its exported env-derived bindings and
// helpers (fetchAndExtract, fetchEnvWithRetries, sleep, the URL pieces). Because
// boot.ts gates its service boot block behind `EXECUTION_KIND !== 'job'`, and
// this module is only imported when EXECUTION_KIND === 'job', that import does
// NOT start the service supervisor — it just evaluates boot.ts top-to-bottom for
// the bindings.
//
// Required env vars (injected by the SDL at deploy time):
//   FUNCTION_ID         opaque function identifier
//   INITIAL_VERSION_ID  version to fetch and run (jobs never reload)
//   BACKEND_BASE_URL    e.g. https://api.example.com (no path)
//   RUNNER_TOKEN        long-lived runner-kind HMAC, scoped to FUNCTION_ID
//   DEPLOYMENT_ID       lease/deployment identifier — stamped on logs + /complete
//   EXECUTION_KIND      'job' (else boot.ts runs the service supervisor)
//   POLL_INTERVAL_MS    heartbeat cadence against /current (default 10000)
//   JOB_ENTRY           optional relative entry path override (for .map()/CLI)

import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
  BACKEND_BASE_URL,
  FUNCTION_ID,
  INITIAL_VERSION_ID,
  RUNNER_TOKEN,
  RUNNER_VERSION,
  authHeader,
  fetchAndExtract,
  fetchEnvWithRetries,
  sleep,
} from './boot';

const RUN_DIR = '/app/run';

const POLL_MIN_MS = 3_000;
const POLL_MAX_MS = 60_000;
const POLL_DEFAULT_MS = 10_000;

// Batched log sink tuning. Flush when the buffer reaches ~16KB OR every 500ms,
// whichever comes first — small enough that a chatty job streams promptly,
// large enough that a quiet job doesn't hammer the backend.
const LOG_FLUSH_BYTES = 16 * 1024;
const LOG_FLUSH_INTERVAL_MS = 500;

// /complete retry policy — mirrors reportHealthWithRetry in boot.ts (3 attempts,
// 500ms*attempt backoff). Losing this report would leave the user with no exit
// code in the dashboard, so a couple of retries on transient blips is worth it.
const COMPLETE_REPORT_ATTEMPTS = 3;
const COMPLETE_REPORT_BACKOFF_MS = 500;

// Exit code emitted by the python-launch.sh wrapper (other package) when
// torch.cuda.is_available() is false. We special-case it into a clearer
// gpu-unavailable phase regardless of how the child surfaces it.
const GPU_UNAVAILABLE_EXIT = 89;

// Entry-point search order. JOB_ENTRY (if set) wins as an explicit relative
// override; otherwise we probe these in order at the run root.
const ENTRY_CANDIDATES = ['main.py', 'src/main.py', 'app.py', 'run.py'];

const env = process.env;
const DEPLOYMENT_ID = env.DEPLOYMENT_ID;
const POLL_INTERVAL_MS = clampPoll(Number(env.POLL_INTERVAL_MS ?? POLL_DEFAULT_MS));

// Built here (not exported from boot.ts) so the `?v=` carries job-mode's view of
// RUNNER_VERSION and we don't depend on boot.ts's internal currentUrl shape.
// `d=<DEPLOYMENT_ID>` scopes the heartbeat + terminal-guard to THIS run so the
// server stamps the right row and computes terminal per-run (concurrent runs of
// one job-function are allowed — D6).
const currentUrl =
  `${BACKEND_BASE_URL}/api/runner/current/${FUNCTION_ID}` +
  `?v=${encodeURIComponent(RUNNER_VERSION)}&d=${encodeURIComponent(DEPLOYMENT_ID ?? '')}`;
const completeUrl = `${BACKEND_BASE_URL}/api/runner/complete/${FUNCTION_ID}`;
const logsUrl = `${BACKEND_BASE_URL}/api/runner/logs/${FUNCTION_ID}`;

if (!FUNCTION_ID || !INITIAL_VERSION_ID || !BACKEND_BASE_URL || !RUNNER_TOKEN) {
  // boot.ts already enforces this and exits 1 before this module is imported,
  // but keep the guard so boot-job is correct if ever invoked directly.
  console.error('[job] missing one of FUNCTION_ID, INITIAL_VERSION_ID, BACKEND_BASE_URL, RUNNER_TOKEN');
  process.exit(1);
}
if (!DEPLOYMENT_ID) {
  console.error('[job] missing DEPLOYMENT_ID');
  process.exit(1);
}

function clampPoll(n: number): number {
  if (!Number.isFinite(n)) return POLL_DEFAULT_MS;
  return Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, Math.floor(n)));
}

type Phase = 'run' | 'install' | 'no-entry' | 'spawn' | 'gpu-unavailable';

let shuttingDown = false;

// ─── boot (job) ───

console.log(
  `[job] FUNCTION_ID=${FUNCTION_ID} version=${INITIAL_VERSION_ID} ` +
    `deployment=${DEPLOYMENT_ID} pollMs=${POLL_INTERVAL_MS}`
);

await main();

// ─── implementation ───

async function main(): Promise<void> {
  await prepareJobDir(RUN_DIR);

  // The boot.ts-exported bindings are typed `string | undefined` (read off
  // process.env). The guard above already exit(1)'d if any were missing, so
  // narrow here for the call signatures below.
  const versionId = INITIAL_VERSION_ID!;

  // Code fetch+extract and env fetch are independent — run them in parallel,
  // same cold-start optimization as service mode. Fail-closed on env: there's no
  // previous-good to fall back to at boot, so retry-then-throw is correct.
  const [, envFetch] = await Promise.all([
    fetchAndExtract(versionId, RUN_DIR),
    fetchEnvWithRetries(),
  ]);
  const fetchedEnv = envFetch.env;

  // Start the heartbeat loop early and keep it running for the whole lifetime
  // (during install, run, AND idle). It stamps runnerSeenAt server-side and is
  // the channel by which we learn the lease has been torn down (404 → exit 0).
  void heartbeatLoop();

  // Terminal-guard (D2): if the run already finished, this is a provider-forced
  // restart of an already-done pod — skip re-running and go straight to idle.
  // Also handles 404 (function deleted → exit 0) inside fetchTerminalState.
  const terminal = await fetchTerminalState();
  if (terminal) {
    console.log('[job] run already terminal, skipping execution and idling');
    await idleUntilTorndown();
    return;
  }

  const entry = pickPythonEntry(RUN_DIR);
  if (!entry) {
    console.error(`[job] no Python entry found; tried JOB_ENTRY + ${ENTRY_CANDIDATES.join(', ')}`);
    await reportComplete({
      exitCode: 1,
      phase: 'no-entry',
      reason: `no entry point found; tried ${ENTRY_CANDIDATES.join(', ')}`,
    });
    await idleUntilTorndown();
    return;
  }

  // Single log sink shared by install + run. The exit code rides /complete, never
  // this channel — logs are lossy/best-effort and must never block completion.
  const sink = createLogSink();

  // D5 fast path: only pip install when requirements.txt is present at the root.
  const installExit = await pipInstallIfNeeded(RUN_DIR, fetchedEnv, sink);
  if (installExit !== 0) {
    console.error(`[job] pip install failed with code ${installExit}`);
    await sink.flush();
    await reportComplete({
      exitCode: installExit,
      phase: 'install',
      reason: `pip install exited with code ${installExit}`,
    });
    await idleUntilTorndown();
    return;
  }

  const result = await runToCompletion(entry, fetchedEnv, sink);

  // Final flush before /complete so the user sees the tail of their output even
  // if the periodic flush hasn't fired since the last chunk.
  await sink.flush();

  if (result.kind === 'spawn-error') {
    console.error(`[job] failed to spawn child: ${result.reason}`);
    await reportComplete({ exitCode: 1, phase: 'spawn', reason: result.reason });
    await idleUntilTorndown();
    return;
  }

  const exitCode = result.exitCode;
  if (exitCode === GPU_UNAVAILABLE_EXIT) {
    console.error('[job] child exited 89 — GPU unavailable (torch.cuda.is_available() false)');
    await reportComplete({
      exitCode,
      phase: 'gpu-unavailable',
      reason: 'GPU unavailable: torch.cuda.is_available() returned false (exit 89)',
    });
    await idleUntilTorndown();
    return;
  }

  console.log(`[job] child exited with code ${exitCode}`);
  await reportComplete({
    exitCode,
    phase: 'run',
    reason: exitCode === 0 ? undefined : `exited with code ${exitCode}`,
  });

  // Idle (D2): do NOT process.exit on success. Keep heartbeating until the lease
  // is torn down and /current returns 404, then exit 0.
  await idleUntilTorndown();
}

// mkdir a fresh run directory, clearing any stale contents from a previous
// container life so a forced restart never runs against a half-extracted tree.
async function prepareJobDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(dir, { recursive: true });
}

// JOB_ENTRY (relative) wins if set and present; otherwise probe the candidates
// in order. Returns the absolute path or undefined.
function pickPythonEntry(dir: string): string | undefined {
  const override = env.JOB_ENTRY?.trim();
  if (override) {
    const full = `${dir}/${override.replace(/^\.?\//, '')}`;
    if (existsSync(full)) return full;
    console.warn(`[job] JOB_ENTRY=${override} not found at ${full}; falling back to defaults`);
  }
  for (const rel of ENTRY_CANDIDATES) {
    const full = `${dir}/${rel}`;
    if (existsSync(full)) return full;
  }
  return undefined;
}

// D5 fast path: no requirements.txt → skip pip entirely, return 0. Otherwise run
// `python3 -m pip install -r requirements.txt` into the system interpreter,
// teeing output to the same log sink so install logs reach the dashboard. Returns
// the pip exit code (0 = success / skipped).
async function pipInstallIfNeeded(
  dir: string,
  fetchedEnv: Record<string, string>,
  sink: LogSink
): Promise<number> {
  const reqPath = `${dir}/requirements.txt`;
  if (!existsSync(reqPath)) {
    console.log('[job] no requirements.txt; skipping pip install');
    return 0;
  }
  console.log('[job] installing requirements.txt');
  const childEnv = mergeChildEnv(fetchedEnv);
  const exit = await spawnAndStream(
    'python3',
    ['-m', 'pip', 'install', '-r', 'requirements.txt'],
    dir,
    childEnv,
    sink
  );
  return exit.kind === 'spawn-error' ? 1 : exit.exitCode;
}

type RunResult = { kind: 'exit'; exitCode: number } | { kind: 'spawn-error'; reason: string };

// Spawn `python3 -u <entry>` to completion with cwd RUN_DIR. NO PORT (this is a
// job, not a server), NO --preload (preload.ts is Bun/JS-only). Both stdout and
// stderr are piped, tee'd to the pod's own stdout/stderr AND fed to the log sink.
async function runToCompletion(
  entry: string,
  fetchedEnv: Record<string, string>,
  sink: LogSink
): Promise<RunResult> {
  console.log(`[job] python3 -u ${entry}`);
  const childEnv = mergeChildEnv(fetchedEnv);
  return spawnAndStream('python3', ['-u', entry], RUN_DIR, childEnv, sink);
}

// Merge order mirrors spawnChild() in boot.ts, MINUS the PORT/USER_PORT rewrite:
// a base default first, then user-fetched vars, then SDL-injected process.env
// (system vars like FUNCTION_ID/RUNNER_TOKEN/BACKEND_BASE_URL win over anything
// a user slipped into function_variables), and we explicitly strip PORT so a job
// never inherits a server port that would confuse user code.
function mergeChildEnv(fetchedEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {
    PYTHONUNBUFFERED: '1',
    ...fetchedEnv,
    ...(process.env as Record<string, string>),
  };
  delete merged.PORT;
  delete merged.USER_PORT;
  return merged;
}

// Spawn a child, stream both pipes to the pod tty + log sink, await exit. Uses
// the reader-loop shape from attachStderrTail in boot.ts (tee every chunk back
// to the pod's own stream so `docker logs`/pod tail look normal). Splits on
// byte/time boundaries via the sink, not only newlines, so `tqdm \r` progress
// bars stream live.
function spawnAndStream(
  command: string,
  args: string[],
  cwd: string,
  childEnv: Record<string, string>,
  sink: LogSink
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ kind: 'spawn-error', reason: (err as Error).message });
      return;
    }

    let settled = false;
    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    // 'error' fires when the binary can't be spawned (e.g. python3 missing) —
    // surfaces as a spawn-error so main() routes it through phase:'spawn'.
    child.on('error', (err) => {
      settle({ kind: 'spawn-error', reason: err.message });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      sink.append('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      sink.append('stderr', chunk);
    });

    child.on('close', (code, signal) => {
      // Normalize to the -256..255 range the contract expects. A signal-kill has
      // no numeric exit code; map it to 128+signo (POSIX convention) so the user
      // sees a non-zero, distinguishable code rather than a silent 0.
      const exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
      settle({ kind: 'exit', exitCode: clampExitCode(exitCode) });
    });
  });
}

function clampExitCode(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(-256, Math.min(255, Math.trunc(n)));
}

// Best-effort POSIX signal → number map for the common kill signals. Anything
// unrecognized maps to 0 so we still produce 128 (generic abnormal exit).
function signalNumber(signal: NodeJS.Signals): number {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
    SIGSEGV: 11,
    SIGABRT: 6,
  };
  return table[signal] ?? 0;
}

// ─── log sink (batched, at-least-once) ───

type LogChunk = { stream: 'stdout' | 'stderr'; text: string; ts: string };

type LogSink = {
  append: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  flush: () => Promise<void>;
};

// Buffers log chunks with a monotonic seq counter and flushes them to
// /api/runner/logs in batches. At-least-once delivery: on POST failure the same
// batch is retried on the next tick (the server dedupes by
// (deploymentId, shardIndex, seq)). Logs are best-effort — flush never throws
// and never blocks run completion.
function createLogSink(): LogSink {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  // Pending chunks not yet acknowledged by a successful POST. Each carries its
  // own seq so retries stay idempotent server-side.
  let pending: Array<LogChunk & { seq: number }> = [];
  let bufferedBytes = 0;
  let seq = 0;
  let flushing = false;

  const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (chunk.byteLength === 0) return;
    // Decode with streaming false per-chunk: a split multi-byte char at a chunk
    // boundary is rare and only ever cosmetically garbles one glyph — acceptable
    // for a best-effort log stream, and avoids holding a chunk back from the
    // user waiting for its continuation.
    const text = decoder.decode(chunk, { stream: true });
    if (text.length === 0) return;
    pending.push({ stream, text, ts: new Date().toISOString(), seq: seq++ });
    bufferedBytes += chunk.byteLength;
    if (bufferedBytes >= LOG_FLUSH_BYTES) {
      void flush();
    }
  };

  // POST whatever is pending. On success, clear it; on failure, leave it so the
  // next tick retries the same batch. Never throws.
  const flush = async (): Promise<void> => {
    if (flushing) return;
    if (pending.length === 0) return;
    flushing = true;
    // Snapshot the batch so chunks appended during the in-flight POST aren't
    // dropped — they accumulate and ride the next flush.
    const batch = pending;
    pending = [];
    const batchBytes = bufferedBytes;
    bufferedBytes = 0;
    const baseSeq = batch[0]!.seq;
    try {
      const res = await fetch(logsUrl, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({
          deploymentId: DEPLOYMENT_ID,
          baseSeq,
          shardIndex: 0,
          chunks: batch.map(({ stream, text, ts }) => ({ stream, text, ts })),
        }),
      });
      if (!res.ok) {
        console.warn(`[job] logs POST ${res.status} ${res.statusText}; will retry batch`);
        // Re-queue at the FRONT so ordering is preserved on retry.
        pending = batch.concat(pending);
        bufferedBytes += batchBytes;
      }
    } catch (err) {
      console.warn(`[job] logs POST failed: ${(err as Error).message}; will retry batch`);
      pending = batch.concat(pending);
      bufferedBytes += batchBytes;
    } finally {
      flushing = false;
    }
  };

  // Periodic flush — fires every LOG_FLUSH_INTERVAL_MS so a quiet stream still
  // reaches the dashboard within ~500ms. unref() so this timer never keeps the
  // process alive on its own.
  const timer = setInterval(() => void flush(), LOG_FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return { append, flush };
}

// ─── heartbeat + terminal guard + idle ───

// Heartbeat loop: GET /current on a cadence to stamp runnerSeenAt server-side
// and to learn (via 404) when the lease has been torn down. Jobs are immutable,
// so this NEVER reloads versions — it only honors the 404 → exit(0) signal.
// Errors must never crash the supervisor; just try again next tick.
async function heartbeatLoop(): Promise<void> {
  while (!shuttingDown) {
    await sleep(POLL_INTERVAL_MS);
    if (shuttingDown) return;
    try {
      const res = await fetch(currentUrl, { headers: authHeader });
      if (res.status === 404) {
        console.log('[job] function deleted / lease torn down upstream, exiting cleanly');
        shuttingDown = true;
        setTimeout(() => process.exit(0), 100);
        return;
      }
      if (res.status === 401) {
        console.error('[job] 401 from /current — runner token rejected; continuing to idle');
        continue;
      }
      if (!res.ok) {
        console.warn(`[job] /current heartbeat returned ${res.status}`);
        // Drain the body so the socket is freed even on non-ok responses.
        await res.body?.cancel().catch(() => undefined);
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (err) {
      console.warn(`[job] heartbeat error: ${(err as Error).message}`);
    }
  }
}

// One-shot terminal-guard read (D2). Returns true if the server reports this run
// already finished (provider-forced restart of a done pod). 404 → function
// deleted, exit(0). Any other failure → treat as non-terminal (run the job)
// rather than skip it, since failing closed here would mean a transient blip
// permanently parks the pod in idle without ever running the user's code.
async function fetchTerminalState(): Promise<boolean> {
  try {
    const res = await fetch(currentUrl, { headers: authHeader });
    if (res.status === 404) {
      console.log('[job] function deleted upstream before run, exiting cleanly');
      shuttingDown = true;
      setTimeout(() => process.exit(0), 100);
      // Park until the exit fires so callers don't proceed to run the job.
      await new Promise<never>(() => {});
    }
    if (!res.ok) {
      console.warn(`[job] terminal-guard /current returned ${res.status}; assuming not terminal`);
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await res.json()) as { terminal?: boolean };
    return body.terminal === true;
  } catch (err) {
    console.warn(`[job] terminal-guard fetch failed: ${(err as Error).message}; assuming not terminal`);
    return false;
  }
}

type CompleteReport = {
  exitCode: number;
  phase: Phase;
  reason?: string;
};

// POST /complete with the same retry policy as reportHealthWithRetry in boot.ts.
// Idempotent server-side. Never throws — a job that finished must not crash the
// supervisor on a flaky completion report; the idle loop carries on regardless.
async function reportComplete(report: CompleteReport): Promise<void> {
  const payload = {
    deploymentId: DEPLOYMENT_ID,
    versionId: INITIAL_VERSION_ID!,
    exitCode: clampExitCode(report.exitCode),
    phase: report.phase,
    reason: report.reason,
    finishedAt: new Date().toISOString(),
  };
  for (let attempt = 1; attempt <= COMPLETE_REPORT_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(completeUrl, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log(`[job] reported /complete phase=${report.phase} exitCode=${payload.exitCode}`);
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      console.warn(`[job] /complete attempt ${attempt}: ${res.status} ${res.statusText}`);
    } catch (err) {
      console.warn(`[job] /complete attempt ${attempt} failed: ${(err as Error).message}`);
    }
    if (attempt < COMPLETE_REPORT_ATTEMPTS) {
      await sleep(COMPLETE_REPORT_BACKOFF_MS * attempt);
    }
  }
  console.error(`[job] /complete failed after ${COMPLETE_REPORT_ATTEMPTS} attempts; idling anyway`);
}

// Idle until the lease is torn down. The heartbeat loop is already running and
// owns the 404 → exit(0) transition; here we just block forever so main()
// doesn't fall off the end and let the process exit (which Akash would restart).
async function idleUntilTorndown(): Promise<void> {
  console.log('[job] run complete; idling until lease teardown (heartbeat awaits 404)');
  while (!shuttingDown) {
    await sleep(POLL_INTERVAL_MS);
  }
}
