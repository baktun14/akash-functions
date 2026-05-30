import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the repo-root .env. Node 21+ ships process.loadEnvFile; the try/catch
// covers the case where the file doesn't exist (defaults below take over).
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile?.(path.resolve(here, '../../../.env'));
} catch {
  // optional — defaults below
}

const Schema = z.object({
  PORT: z.coerce.number().default(8081),
  DATABASE_URL: z
    .string()
    .default('postgres://baktun14@localhost:5433/akash_functions')
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return (
            (u.protocol === 'postgres:' || u.protocol === 'postgresql:') &&
            u.hostname.length > 0
          );
        } catch {
          return false;
        }
      },
      { message: 'DATABASE_URL must be a postgres:// URL with a non-empty hostname' }
    ),
  AKASH_API_BASE: z.string().default('https://console-api.akash.network/v1'),
  // `:latest` is resolved to a concrete `:X.Y.Z` at SDL build time (Akash
  // rejects floating tags). See packages/server/src/akash/runner-image.ts.
  RUNNER_IMAGE: z.string().default('ghcr.io/baktun14/akash-functions-runner:latest'),
  // Image for Python job runs. Same `:latest`→`:X.Y.Z` resolution as
  // RUNNER_IMAGE, but pinned to the `pyrunner-v*` release train.
  PYTHON_RUNNER_IMAGE: z
    .string()
    .default('ghcr.io/baktun14/akash-functions-python-runner:latest'),
  CODE_SIGNING_SECRET: z.string().min(16).default('dev-secret-change-me-32-bytes-min'),
  CODE_HOST_BASE: z.string().default('http://host.docker.internal:8081'),
  // Console API takes deposit as a number in dollars (the API converts to AKT).
  DEPLOY_DEPOSIT: z.coerce.number().positive().default(0.5),
  DEPLOY_PRICING_AMOUNT: z.coerce.number().default(1000),
  // Base64-encoded 32-byte AES-256 key for encrypting function variables at
  // rest. Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // Losing this key makes every encrypted variable unrecoverable — back it up.
  // The default below is for local dev only and is intentionally well-known;
  // production deployments MUST override it.
  MASTER_ENCRYPTION_KEY: z
    .string()
    .default('vNTtsiJJ19r9TRD/f+NB91fKpEsdx3JQDdb5lWjpB6o=')
    .refine((s) => Buffer.from(s, 'base64').length === 32, {
      message: 'MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)',
    }),

  // ── Python job (run-to-completion) tuning ──
  // How long a job lease may sit before its runner's first heartbeat before the
  // reconciler force-terminates it. Cold image pull + pip can be slow, so this
  // is generous and SEPARATE from the run duration cap.
  JOB_BOOT_TIMEOUT_MS: z.coerce.number().default(15 * 60_000),
  // A `running` job whose runner heartbeat (`runnerSeenAt`) goes stale this long
  // is presumed dead; the reconciler tears the lease down.
  JOB_RUNNER_SILENCE_MS: z.coerce.number().default(90_000),
  // Capped teardown retries before giving up (the lease then relies on
  // on-chain cross-check / poll-drain fallback).
  JOB_TEARDOWN_MAX_ATTEMPTS: z.coerce.number().default(8),
  // Runaway backstop (NOT a cost cap) — generous default, user-overridable,
  // snapshotted onto the deployment row at submit time. Now genuinely
  // enforceable because the reconciler holds the cached key (D1).
  JOB_MAX_DURATION_MS: z.coerce.number().default(6 * 60 * 60_000),

  // ── Python job GPU fallback ──
  // Per-attempt bid wait for a GPU job. Shorter than the service 60s ceiling so
  // an unavailable GPU is detected fast and we move to the next candidate.
  GPU_FALLBACK_BID_TIMEOUT_MS: z.coerce.number().default(20_000),
  // Max GPUs to try (requested + alternates) before giving up. Keep
  // MAX_ATTEMPTS × BID_TIMEOUT well under JOB_BOOT_TIMEOUT_MS so the reconciler
  // (which ages a job from createdAt) doesn't fail a still-searching run.
  GPU_FALLBACK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

  // ── Python job GPU multi-group fan-out (initial launch only) ──
  // Total time to poll bids across all groups of the single multi-group
  // deployment before giving up (→ wait-for-capacity park, else fail). One
  // create covers every candidate, so this replaces the sequential path's
  // MAX_ATTEMPTS × BID_TIMEOUT (~120s) with a single bounded window.
  GPU_PARALLEL_BID_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Once a NON-requested group gets an eligible bid, wait this much longer for
  // the requested (or a better-ranked) group to bid before committing to the
  // best collected. The requested group short-circuits this window.
  GPU_PARALLEL_BID_WINDOW_MS: z.coerce.number().default(6_000),

  // ── Wait-for-capacity (delayed start) ──
  // Default wait budget when a deploy opts in without specifying one.
  WAIT_FOR_CAPACITY_DEFAULT_MAX_WAIT_MS: z.coerce.number().default(24 * 60 * 60_000), // 24h
  // Hard ceiling — a user may extend up to here, never beyond.
  WAIT_FOR_CAPACITY_MAX_WAIT_MS: z.coerce.number().default(7 * 24 * 60 * 60_000), // 7d
  // Floor — a wait always gets at least this long (≥ one burst window) so an
  // opt-in deploy never auto-fails near-instantly.
  WAIT_FOR_CAPACITY_MIN_WAIT_MS: z.coerce.number().default(5 * 60_000), // 5m
  // Per reconciler tick, fire at most this many bursts (oldest-waiter-first) so
  // a freed slot doesn't trigger a thundering herd of create/close cycles.
  WAIT_FOR_CAPACITY_MAX_BURSTS_PER_TICK: z.coerce.number().int().positive().default(8),
  // A burst running longer than this is presumed dead/hung; the watchdog
  // reclaims the row to `waiting`. MUST exceed worst-case live burst wall-time
  // (GPU_FALLBACK_MAX_ATTEMPTS × GPU_FALLBACK_BID_TIMEOUT_MS ≈ 120s) so a
  // still-running burst is never reclaimed (which would double-create), and stay
  // below JOB_BOOT_TIMEOUT_MS.
  WAIT_FOR_CAPACITY_BURST_TIMEOUT_MS: z.coerce.number().default(5 * 60_000), // 5m
});

export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
