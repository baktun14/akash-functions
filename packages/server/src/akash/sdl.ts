// SDL builder — emits a single-service deployment that runs the Akash Functions
// runner image. The runner fetches user code from BACKEND_BASE_URL at boot,
// then polls /api/runner/current/:fnId every POLL_INTERVAL_MS to hot-reload
// new versions without re-leasing the deployment.
//
// CPU/memory/storage come from function_versions.resources. Pricing amount
// (uakt) and the runner image come from env. AkashML key, if present, becomes
// an env var on the deployed service.

import yaml from 'js-yaml';
import { env } from '../env';
import { resolveRunnerImage } from './runner-image';

export type ResourceSpec = {
  cpu: string;     // "0.5" or "0.5 vCPU"
  memory: string;  // "512Mi" or "512 Mi"
  storage: string; // "1Gi"
};

export type BuildSdlArgs = {
  functionId: string;
  /** Version the runner fetches at first boot. Subsequent versions are picked
   *  up by the runner's poll loop. */
  initialVersionId: string;
  /** Long-lived runner-kind HMAC, scoped to functionId. */
  runnerToken: string;
  resources: ResourceSpec;
  akashmlKey?: string | undefined;
  /** Override the public host for backend callbacks. Defaults to env.CODE_HOST_BASE. */
  backendBaseUrl?: string;
  /** Override the runner's poll cadence. Defaults to 10s. */
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 10_000;

function normalizeCpu(input: string): number {
  const num = parseFloat(input.replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : 0.5;
}

function normalizeSize(input: string): string {
  // Strip whitespace and uppercase, allow "512Mi", "512 Mi", "1Gi", "1 GiB" → "512Mi" / "1Gi"
  const cleaned = input.replace(/\s+/g, '').replace(/iB$/i, 'i');
  if (/^\d+(\.\d+)?(Ki|Mi|Gi|Ti)$/i.test(cleaned)) {
    return cleaned.replace(/i$/, (m) => m.toLowerCase()).replace(/(?<=\d)([kmgt])i$/i, (m) => m.toUpperCase());
  }
  return cleaned;
}

export async function buildSdl(args: BuildSdlArgs): Promise<string> {
  const backendBaseUrl = (args.backendBaseUrl ?? env.CODE_HOST_BASE).replace(/\/$/, '');
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runnerImage = await resolveRunnerImage();

  const envVars: string[] = [
    `FUNCTION_ID=${args.functionId}`,
    `INITIAL_VERSION_ID=${args.initialVersionId}`,
    `BACKEND_BASE_URL=${backendBaseUrl}`,
    `RUNNER_TOKEN=${args.runnerToken}`,
    `POLL_INTERVAL_MS=${pollIntervalMs}`,
    'PORT=3000',
  ];
  if (args.akashmlKey) {
    envVars.push(`AKASHML_API_KEY=${args.akashmlKey}`);
  }

  const sdl = {
    version: '2.0',
    services: {
      fn: {
        image: runnerImage,
        expose: [
          {
            port: 3000,
            as: 80,
            to: [{ global: true }],
          },
        ],
        env: envVars,
      },
    },
    profiles: {
      compute: {
        fn: {
          resources: {
            cpu: { units: normalizeCpu(args.resources.cpu) },
            memory: { size: normalizeSize(args.resources.memory) },
            storage: { size: normalizeSize(args.resources.storage) },
          },
        },
      },
      placement: {
        dcloud: {
          attributes: { host: 'akash' },
          pricing: {
            fn: { denom: 'uakt', amount: env.DEPLOY_PRICING_AMOUNT },
          },
        },
      },
    },
    deployment: {
      fn: {
        dcloud: { profile: 'fn', count: 1 },
      },
    },
  };

  return yaml.dump(sdl, { noRefs: true, lineWidth: 1000 });
}
