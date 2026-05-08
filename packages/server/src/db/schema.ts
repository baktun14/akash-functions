import { sql, desc } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
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

export type FunctionRow = typeof functions.$inferSelect;
export type FunctionInsert = typeof functions.$inferInsert;
export type FunctionVersionRow = typeof functionVersions.$inferSelect;
export type FunctionVersionInsert = typeof functionVersions.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentInsert = typeof deployments.$inferInsert;
export type KeyLinkRow = typeof keyLinks.$inferSelect;
export type KeyLinkInsert = typeof keyLinks.$inferInsert;
