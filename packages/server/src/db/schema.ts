import { sql, desc } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Owner identity is the user's Akash wallet address (akash1…), resolved from
// the API key on every authed request and cached via key_links. ownerHash —
// sha256(apiKey).slice(0,16) — is kept transitionally for safe rollback during
// the migration; new code reads/writes wallet_address.

export const functions = pgTable(
  'functions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerHash: text('owner_hash').notNull(),
    walletAddress: text('wallet_address'),
    name: text('name').notNull(),
    subdomain: text('subdomain').notNull().unique(),
    status: text('status').notNull().default('draft'),
    // Source of truth for whether this is a long-lived HTTP **service** or an
    // ephemeral Python **job** (run-to-completion on a GPU, auto-torn-down).
    // Immutable at creation — a function is permanently one product or the
    // other (D3). The entire UI routes on this (FunctionRecord.kind).
    executionKind: text('execution_kind').notNull().default('service'),
    // Bumped in the same transaction as any function_variables mutation.
    // The runner polls /api/runner/current/:fnId and uses this counter to
    // detect when it should refetch /api/runner/env/:fnId and respawn the
    // user process with new env.
    variablesRevision: bigint('variables_revision', { mode: 'number' })
      .notNull()
      .default(0),
    // Per-function set of routes that require a wallet-scoped API key. Each
    // entry is a `"<METHOD> <path>"` string (e.g. `"POST /api/secret"`). The
    // runner sidecar polls /api/runner/current/:fnId and uses this list to
    // reject unauthenticated calls before they reach user code.
    protectedRoutes: jsonb('protected_routes')
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    walletIdx: index('functions_wallet_address_idx').on(table.walletAddress),
  })
);

// Caches resolved (apiKeyHash → walletAddress) so we don't hit the Console API
// on every authed request. Populated on first sighting of a key.
export const keyLinks = pgTable('key_links', {
  apiKeyHash: text('api_key_hash').primaryKey(),
  walletAddress: text('wallet_address').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

// User-issued API keys for protecting function routes. Wallet-scoped: a key
// belongs to a wallet and authorizes calls to any of that wallet's deployed
// functions on routes the manifest declared as `auth: 'apiKey'`. Plaintext is
// shown once at creation and never persisted; only the SHA-256 hash is stored.
// The runner sidecar receives the wallet's set of hashes via the same
// /api/runner/current poll it already uses for version updates.
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletAddress: text('wallet_address').notNull(),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    maskedTail: text('masked_tail').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    walletIdx: index('api_keys_wallet_address_idx').on(table.walletAddress),
  })
);

export const functionVersions = pgTable(
  'function_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    functionId: uuid('function_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    preset: text('preset').notNull(),
    prompt: text('prompt'),
    message: text('message'),
    // User code is stored AES-256-GCM-encrypted (same envelope as
    // function_variables). Plaintext is never written; readSource() in
    // packages/server/src/lib/source.ts is the only path that decrypts.
    sourceCiphertext: text('source_ciphertext').notNull(),
    sourceIv: text('source_iv').notNull(),
    sourceAuthTag: text('source_auth_tag').notNull(),
    sourceKeyVersion: integer('source_key_version').notNull().default(1),
    resources: jsonb('resources').notNull().$type<{
      cpu: string;
      memory: string;
      storage: string;
      gpu?: {
        vendor: 'nvidia' | 'amd';
        model: string;
        units?: number;
      };
    }>(),
    envVars: jsonb('env_vars').notNull().default(sql`'{}'::jsonb`).$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    funcCreatedIdx: index('fn_versions_function_created_idx').on(
      table.functionId,
      desc(table.createdAt)
    ),
  })
);

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  functionId: uuid('function_id')
    .notNull()
    .references(() => functions.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id')
    .notNull()
    .references(() => functionVersions.id, { onDelete: 'cascade' }),
  dseq: text('dseq'),
  gseq: integer('gseq').default(1),
  oseq: integer('oseq').default(1),
  provider: text('provider'),
  uris: text('uris').array(),
  state: text('state').notNull().default('pending'),
  errorMessage: text('error_message'),
  // Denormalized copy of functions.execution_kind so the (keyless) reconciler
  // can branch on service-vs-job without a join (D3). Set at deployment insert.
  runKind: text('run_kind').notNull().default('service'),
  // Run outcome — what the user's script did — is ORTHOGONAL to `state` (the
  // Akash lease lifecycle). Teardown sets state='closed' within seconds of a
  // job finishing, which would clobber a success/failure value if it lived in
  // `state`. So the durable run result lives here, written only by /complete
  // and cancel, NEVER by teardown (D4). null | succeeded | failed | canceled.
  runOutcome: text('run_outcome'),
  // Process exit code reported by the runner on /complete (for the "Exit N"
  // display). -256..255.
  exitCode: integer('exit_code'),
  // GPU of the current/last deploy attempt — for display + cost. For jobs this
  // can change across availability-driven fallback attempts, so it lives on the
  // deployment row (not just the version). gpu_attempt: 0 = the originally-
  // requested GPU; ≥1 = a fallback attempt. `state='bidding' && gpu_attempt>0`
  // is the UI's "searching for another GPU" signal.
  gpuVendor: text('gpu_vendor'),
  gpuModel: text('gpu_model'),
  gpuAttempt: integer('gpu_attempt').notNull().default(0),
  // When the user's script actually started (first runner heartbeat) and
  // finished (runner /complete). Distinct from lease createdAt/closedAt.
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // Runaway backstop snapshotted onto the row at submit time (D5/D6). The
  // reconciler force-terminates a job that overruns this.
  maxDurationMs: integer('max_duration_ms'),
  // ── Wait-for-capacity (delayed start) ──
  // Opt-in: on no-bid, enter the durable `waiting` state instead of `failed`,
  // and let the reconciler retry until a lease lands / cancel / cap. Default
  // OFF preserves today's fail-fast.
  waitForCapacity: boolean('wait_for_capacity').notNull().default(false),
  // Per-row wait budget; null → env default. Clamped to [floor, ceiling].
  maxWaitMs: integer('max_wait_ms'),
  // Cap + FIFO-fairness anchor. Set ONCE on first entry to `waiting` (COALESCE),
  // never reset in v1, so it serves both the timeout cap and oldest-first
  // ordering. Distinct from createdAt (which the boot/stuck watchdogs age on).
  waitingSince: timestamp('waiting_since', { withTimezone: true }),
  // Watchdog + backoff anchor: stamped on each waiting→bidding burst claim. The
  // boot/stuck watchdogs age waitForCapacity rows on THIS (not createdAt, which
  // is hours-old for a long waiter) so a retry burst isn't instantly failed; a
  // burst past WAIT_FOR_CAPACITY_BURST_TIMEOUT_MS is reclaimed to `waiting`.
  burstStartedAt: timestamp('burst_started_at', { withTimezone: true }),
  // Autonomous-teardown state machine (D1): null | requested | closing | done.
  // CAS-claimed by the teardown driver so /complete and the reconciler
  // watchdog can't double-close.
  teardownState: text('teardown_state'),
  teardownAttempts: integer('teardown_attempts').notNull().default(0),
  // Self-reported by the running runner on each /api/runner/current poll. Null
  // means the runner has never reported (legacy image pre-version-reporting,
  // or a fresh deployment that hasn't polled yet — `runnerSeenAt` disambiguates).
  runnerVersion: text('runner_version'),
  runnerSeenAt: timestamp('runner_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  liveAt: timestamp('live_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

// User-defined environment variables, encrypted at rest with AES-256-GCM.
// Decoupled from function_versions so a user can add/edit/remove variables
// without creating a code version. The runner picks up changes via the
// variables_revision counter on functions and respawns the user process.
//
// Plaintext NEVER lives in this table — only ciphertext + iv + auth_tag.
// Plaintext is only emitted on the runner-only /api/runner/env/:fnId route,
// authenticated by an HMAC token scoped to fnId.
export const functionVariables = pgTable(
  'function_variables',
  {
    functionId: uuid('function_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.functionId, table.key] }),
    keyShape: check(
      'function_variables_key_shape',
      sql`${table.key} ~ '^[A-Z][A-Z0-9_]{0,127}$'`
    ),
    keyReserved: check(
      'function_variables_key_not_reserved',
      sql`${table.key} NOT IN ('FUNCTION_ID','INITIAL_VERSION_ID','BACKEND_BASE_URL','RUNNER_TOKEN','POLL_INTERVAL_MS','PORT','EXECUTION_KIND','DEPLOYMENT_ID')`
    ),
  })
);

// Encrypted, run-scoped cache of the user's OWN Akash Console API key (D1).
// Why this exists: the Console key never lives anywhere outside an incoming
// authed request, but autonomous teardown (close the lease seconds after a job
// exits, with no browser open) needs a key. So at run-submit — an authed
// request that carries the key — we cache it encrypted at rest (same AES-256-GCM
// envelope as function_variables / source), keyed to the wallet, refreshed on
// every authed request, and evicted when the wallet has no active runs. Read
// ONLY by the teardown driver; the key NEVER enters the pod.
//
// Threat model (see ADR): a server compromise exposes these cached user
// credentials. Bounded by encryption-at-rest + eviction when no runs are active.
export const walletConsoleKeys = pgTable('wallet_console_keys', {
  walletAddress: text('wallet_address').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only log lines for job runs. Persists past teardown so a finished run
// can replay its output. `seq` is monotonic per (deployment, shard); the unique
// index dedupes retried POSTs from the runner's at-least-once log sink.
// `shard_index` is 0 today; Phase 2 (.map() fan-out) will use it to interleave
// N shards under one logical run.
export const runLogs = pgTable(
  'run_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stream: text('stream').notNull(),
    chunk: text('chunk').notNull(),
    shardIndex: integer('shard_index').notNull().default(0),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deploymentSeqIdx: index('run_logs_deployment_seq_idx').on(
      table.deploymentId,
      table.seq
    ),
    dedupeIdx: uniqueIndex('run_logs_deployment_shard_seq_uq').on(
      table.deploymentId,
      table.shardIndex,
      table.seq
    ),
  })
);

// Tracks per-provider deploy health so the bid picker can skip providers whose
// ingress can't actually serve our function routes. The reconciler probes a
// reserved runner path (/_akash_runner/health) through the provider ingress;
// repeated failures (with the runner heartbeat stale) increment
// consecutiveFailures, and crossing the threshold sets cooldownUntil into the
// future so pipeline.ts excludes the provider from bid selection. Successful
// probes reset consecutiveFailures and clear cooldownUntil.
//
// Cooldown is timestamp-based — blocked providers never see traffic, so they
// can't earn a success signal to clear themselves; the cooldown window expires
// on its own and the provider re-enters the pool naturally.
export const providerHealth = pgTable(
  'provider_health',
  {
    address: text('address').primaryKey(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    totalFailures: integer('total_failures').notNull().default(0),
    totalSuccesses: integer('total_successes').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureReason: text('last_failure_reason'),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cooldownIdx: index('provider_health_cooldown_until_idx').on(table.cooldownUntil),
  })
);

export type FunctionRow = typeof functions.$inferSelect;
export type FunctionInsert = typeof functions.$inferInsert;
export type FunctionVersionRow = typeof functionVersions.$inferSelect;
export type FunctionVersionInsert = typeof functionVersions.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentInsert = typeof deployments.$inferInsert;
export type KeyLinkRow = typeof keyLinks.$inferSelect;
export type KeyLinkInsert = typeof keyLinks.$inferInsert;
export type FunctionVariableRow = typeof functionVariables.$inferSelect;
export type FunctionVariableInsert = typeof functionVariables.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
export type ProviderHealthRow = typeof providerHealth.$inferSelect;
export type ProviderHealthInsert = typeof providerHealth.$inferInsert;
export type WalletConsoleKeyRow = typeof walletConsoleKeys.$inferSelect;
export type WalletConsoleKeyInsert = typeof walletConsoleKeys.$inferInsert;
export type RunLogRow = typeof runLogs.$inferSelect;
export type RunLogInsert = typeof runLogs.$inferInsert;
