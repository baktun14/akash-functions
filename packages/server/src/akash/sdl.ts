// SDL builder — emits a single-service deployment that runs the Akash Functions
// runner image. The runner fetches user code from BACKEND_BASE_URL at boot,
// then polls /api/runner/current/:fnId every POLL_INTERVAL_MS to hot-reload
// new versions without re-leasing the deployment.
//
// CPU/memory/storage come from function_versions.resources. Pricing amount
// (uakt) and the runner image come from env. User-defined env vars (e.g.
// AKASHML_API_KEY, DATABASE_URL) are NOT emitted here — the SDL manifest is
// visible to providers and is unsuitable for secrets. The runner instead
// fetches them from /api/runner/env/:fnId at boot and on poll-detected
// changes, over an HMAC-authenticated channel.

import yaml from 'js-yaml';
import { env } from '../env';
import { resolveRunnerImage } from './runner-image';

export type GpuSpec = {
  vendor: 'nvidia' | 'amd';
  model: string;       // e.g. "a100", "h100", "rtx4090"
  units?: number;      // default 1
};

export type ResourceSpec = {
  cpu: string;     // "0.5" or "0.5 vCPU"
  memory: string;  // "512Mi" or "512 Mi"
  storage: string; // "1Gi"
  gpu?: GpuSpec;
};

export type BuildSdlArgs = {
  functionId: string;
  /** Version the runner fetches at first boot. Subsequent versions are picked
   *  up by the runner's poll loop. */
  initialVersionId: string;
  /** Long-lived runner-kind HMAC, scoped to functionId. */
  runnerToken: string;
  resources: ResourceSpec;
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

// Pricing cap (uakt/block) — providers bid at-or-below this. Setting it
// higher costs nothing unless the bid actually lands above the previous cap
// (lowest bid wins). GPU providers floor much higher than CPU providers, so
// the CPU baseline (env.DEPLOY_PRICING_AMOUNT, ~1000 uakt/block ≈ $0.78/hr)
// is below most GPU providers' floor and produces 0 bids on GPU SDLs.
//
// We don't fetch live pricing — the Console API doesn't expose per-model
// floors. The numbers below are conservative ceilings derived from observed
// provider listings (community + Console pricing pages, early 2026). They
// stay well clear of the chain's max-bid ceiling (1e18 uakt).
function pricingAmount(gpu: GpuSpec | undefined): number {
  const base = env.DEPLOY_PRICING_AMOUNT;
  if (!gpu) return base;
  const model = gpu.model.toLowerCase();
  // Datacenter / hopper / ada-class — H100/H200/A100/L40/RTX 6000 Pro etc.
  // Floor ~$1.50–$3.00/hr; 100,000 uakt/block ≈ $2.30/hr at $1.30/AKT.
  if (/^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(model)) {
    return Math.max(base, 100_000);
  }
  // Mid-tier consumer / workstation — RTX 4090, RTX 5070, A5000, etc.
  // Floor ~$0.30–$1.00/hr; 30,000 uakt/block ≈ $0.70/hr.
  if (/^(rtx|gtx|a5000|a4000|t4|p4|p40)/.test(model)) {
    return Math.max(base, 30_000);
  }
  // Unknown GPU model — use mid-tier ceiling as a sensible default.
  return Math.max(base, 30_000);
}

function normalizeSize(input: string): string {
  // Normalize to k8s-style "Ki" / "Mi" / "Gi" / "Ti": uppercase first letter,
  // lowercase "i". Accepts "512mi", "1 GiB", "1Gi" → "512Mi" / "1Gi".
  // Previously matched the whole 2-char suffix and uppercased it, producing
  // "GI" — which the strict Akash bid-matcher rejects and providers may
  // silently misinterpret.
  const cleaned = input.replace(/\s+/g, '').replace(/iB$/i, 'i');
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([kmgt])i$/i);
  if (m) return `${m[1]}${m[2]!.toUpperCase()}i`;
  return cleaned;
}

export async function buildSdl(args: BuildSdlArgs): Promise<string> {
  const backendBaseUrl = (args.backendBaseUrl ?? env.CODE_HOST_BASE).replace(/\/$/, '');
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const runnerImage = await resolveRunnerImage();

  // Only system-level vars go in the SDL — these are visible to providers.
  // User secrets (function_variables) are fetched separately at runtime.
  const envVars: string[] = [
    `FUNCTION_ID=${args.functionId}`,
    `INITIAL_VERSION_ID=${args.initialVersionId}`,
    `BACKEND_BASE_URL=${backendBaseUrl}`,
    `RUNNER_TOKEN=${args.runnerToken}`,
    `POLL_INTERVAL_MS=${pollIntervalMs}`,
    'PORT=3000',
  ];

  // Inline the GPU block only when requested. Akash SDL expects:
  //   gpu:
  //     units: <n>
  //     attributes:
  //       vendor:
  //         <vendor>:
  //           - model: <model>
  // Providers that don't expose this exact model won't bid.
  const computeResources: Record<string, unknown> = {
    cpu: { units: normalizeCpu(args.resources.cpu) },
    memory: { size: normalizeSize(args.resources.memory) },
    storage: { size: normalizeSize(args.resources.storage) },
  };
  if (args.resources.gpu) {
    const { vendor, model, units } = args.resources.gpu;
    computeResources.gpu = {
      units: units ?? 1,
      attributes: {
        vendor: {
          [vendor]: [{ model }],
        },
      },
    };
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
          resources: computeResources,
        },
      },
      placement: {
        dcloud: {
          attributes: { host: 'akash' },
          pricing: {
            fn: { denom: 'uakt', amount: pricingAmount(args.resources.gpu) },
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
