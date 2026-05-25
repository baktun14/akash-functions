import { sql, desc } from 'drizzle-orm';
import {
  bigint,
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
  // Self-reported by the running runner on each /api/runner/current poll. Null
  // means the runner has never reported (legacy image pre-version-reporting,
  // or a fresh deployment that hasn't polled yet — `runnerSeenAt` disambiguates).
  runnerVersion: text('runner_version'),
  runnerSeenAt: timestamp('runner_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  liveAt: timestamp('live_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

// Stable public aliases for function ingress. Vercel-compatible deployments
// use opaque public IDs plus an origin token so callers hit:
//   /i/<public_id>/api/...
// rather than a provider-specific lease hostname. The token is a capability
// secret for invocation only; management still requires the Akash Console key.
export const functionAliases = pgTable(
  'function_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: text('public_id').notNull().unique(),
    walletAddress: text('wallet_address').notNull(),
    project: text('project').notNull(),
    route: text('route').notNull(),
    routeKind: text('route_kind').notNull(),
    functionId: uuid('function_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    exposure: text('exposure').notNull().default('vercel-rewrite'),
    originTokenHash: text('origin_token_hash').notNull(),
    originTokenCiphertext: text('origin_token_ciphertext').notNull(),
    originTokenIv: text('origin_token_iv').notNull(),
    originTokenAuthTag: text('origin_token_auth_tag').notNull(),
    originTokenKeyVersion: integer('origin_token_key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    walletIdx: index('function_aliases_wallet_address_idx').on(table.walletAddress),
    functionIdx: index('function_aliases_function_id_idx').on(table.functionId),
    projectRouteUnique: uniqueIndex('function_aliases_wallet_project_route_idx').on(
      table.walletAddress,
      table.project,
      table.route
    ),
  })
);

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
      sql`${table.key} NOT IN ('FUNCTION_ID','INITIAL_VERSION_ID','BACKEND_BASE_URL','RUNNER_TOKEN','POLL_INTERVAL_MS','PORT')`
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
export type FunctionAliasRow = typeof functionAliases.$inferSelect;
export type FunctionAliasInsert = typeof functionAliases.$inferInsert;
export type KeyLinkRow = typeof keyLinks.$inferSelect;
export type KeyLinkInsert = typeof keyLinks.$inferInsert;
export type FunctionVariableRow = typeof functionVariables.$inferSelect;
export type FunctionVariableInsert = typeof functionVariables.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
export type ProviderHealthRow = typeof providerHealth.$inferSelect;
export type ProviderHealthInsert = typeof providerHealth.$inferInsert;
