import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().default(8081),
  DATABASE_URL: z.string().default('postgres://baktun14@localhost:5433/akash_functions'),
  AKASH_API_BASE: z.string().default('https://console-api.akash.network/v1'),
  RUNNER_IMAGE: z.string().default('ghcr.io/baktun14/akash-functions-runner:1.0.0'),
  CODE_SIGNING_SECRET: z.string().min(16).default('dev-secret-change-me-32-bytes-min'),
  CODE_HOST_BASE: z.string().default('http://host.docker.internal:8081'),
  DEPLOY_DEPOSIT: z.string().default('5000000uakt'),
  DEPLOY_PRICING_AMOUNT: z.coerce.number().default(1000),
});

export const env = Schema.parse(process.env);
export type Env = z.infer<typeof Schema>;
