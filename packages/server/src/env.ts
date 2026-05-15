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
  DATABASE_URL: z.string().default('postgres://baktun14@localhost:5433/akash_functions'),
  AKASH_API_BASE: z.string().default('https://console-api.akash.network/v1'),
  // `:latest` is resolved to a concrete `:X.Y.Z` at SDL build time (Akash
  // rejects floating tags). See packages/server/src/akash/runner-image.ts.
  RUNNER_IMAGE: z.string().default('ghcr.io/baktun14/akash-functions-runner:latest'),
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
});

export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
