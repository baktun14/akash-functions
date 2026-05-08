// SDL builder — emits a single-service deployment that runs the Akash Functions
// runner image. The runner fetches user code from CODE_URL at boot, installs
// deps, then spawns `bun src/index.ts`.
//
// CPU/memory/storage come from function_versions.resources. Pricing amount
// (uakt) and the runner image come from env. AkashML key, if present, becomes
// an env var on the deployed service.

import yaml from 'js-yaml';
import { env } from '../env';

export type ResourceSpec = {
  cpu: string;     // "0.5" or "0.5 vCPU"
  memory: string;  // "512Mi" or "512 Mi"
  storage: string; // "1Gi"
};

export type BuildSdlArgs = {
  functionId: string;
  versionId: string;
  codeToken: string;
  resources: ResourceSpec;
  akashmlKey?: string | undefined;
  /** Override the public host for CODE_URL. Defaults to env.CODE_HOST_BASE. */
  codeHostBase?: string;
};

function normalizeCpu(input: string): number {
  const num = parseFloat(input.replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : 0.5;
}

function normalizeSize(input: string): string {
  // Strip whitespace and uppercase, allow "512Mi", "512 Mi", "1Gi", "1 GiB" → "512Mi" / "1Gi"
  const cleaned = input.replace(/\s+/g, '').replace(/iB$/i, 'i');
  // SDL accepts e.g. "512Mi", "1Gi" — keep as-is when it matches; else fall back.
  if (/^\d+(\.\d+)?(Ki|Mi|Gi|Ti)$/i.test(cleaned)) {
    return cleaned.replace(/i$/, (m) => m.toLowerCase()).replace(/(?<=\d)([kmgt])i$/i, (m) => m.toUpperCase());
  }
  return cleaned;
}

export function buildSdl(args: BuildSdlArgs): string {
  const codeHost = args.codeHostBase ?? env.CODE_HOST_BASE;
  const codeUrl = `${codeHost.replace(/\/$/, '')}/api/runner/code/${args.functionId}/${args.versionId}`;

  const envVars: string[] = [
    `FUNCTION_ID=${args.functionId}`,
    `VERSION_ID=${args.versionId}`,
    `CODE_URL=${codeUrl}`,
    `CODE_TOKEN=${args.codeToken}`,
    'PORT=3000',
  ];
  if (args.akashmlKey) {
    envVars.push(`AKASHML_API_KEY=${args.akashmlKey}`);
  }

  const sdl = {
    version: '2.0',
    services: {
      fn: {
        image: env.RUNNER_IMAGE,
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
