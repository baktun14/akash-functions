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
  RUNNER_IMAGE: z.string().default('ghcr.io/baktun14/akash-functions-runner:2.0.0'),
  CODE_SIGNING_SECRET: z.string().min(16).default('dev-secret-change-me-32-bytes-min'),
  CODE_HOST_BASE: z.string().default('http://host.docker.internal:8081'),
  // Console API takes deposit as a number in dollars (the API converts to USDC).
  DEPLOY_DEPOSIT: z.coerce.number().positive().default(5),
  DEPLOY_PRICING_AMOUNT: z.coerce.number().default(1000),
});

export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
