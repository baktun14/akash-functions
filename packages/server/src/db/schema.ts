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
    source: jsonb('source').notNull().$type<Record<string, string>>(),
    resources: jsonb('resources').notNull().$type<{
      cpu: string;
      memory: string;
      storage: string;
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
      sql`${table.key} NOT IN ('FUNCTION_ID','INITIAL_VERSION_ID','BACKEND_BASE_URL','RUNNER_TOKEN','POLL_INTERVAL_MS','PORT')`
    ),
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
