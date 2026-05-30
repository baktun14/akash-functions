// SDL builder — emits a single-service deployment that runs the Akash Functions
// runner image. The runner fetches user code from BACKEND_BASE_URL at boot,
// then polls /api/runner/current/:fnId every POLL_INTERVAL_MS to hot-reload
// new versions without re-leasing the deployment.
//
// CPU/memory/storage come from function_versions.resources. Pricing amount
// (uact) and the runner image come from env. User-defined env vars (e.g.
// AKASHML_API_KEY, DATABASE_URL) are NOT emitted here — the SDL manifest is
// visible to providers and is unsuitable for secrets. The runner instead
// fetches them from /api/runner/env/:fnId at boot and on poll-detected
// changes, over an HMAC-authenticated channel.

import yaml from 'js-yaml';
import { env } from '../env';
import { resolvePythonRunnerImage, resolveRunnerImage } from './runner-image';

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
  /** 'service' (long-lived HTTP, default) or 'job' (run-to-completion Python).
   *  Jobs use the python-runner image and get EXECUTION_KIND=job + DEPLOYMENT_ID
   *  injected so the supervisor dispatches to job mode and scopes its
   *  log/complete callbacks. */
  executionKind?: 'service' | 'job';
  /** Deployment (run) row id — REQUIRED for jobs; injected as DEPLOYMENT_ID so
   *  the runner's /logs and /complete callbacks address the right run. */
  deploymentId?: string;
  /** Multi-group GPU fan-out: one placement group per entry, in this order,
   *  each a different GPU compute profile, all under the single `fn` service.
   *  2+ entries → multi-group SDL; 0–1 entries → today's single-group SDL.
   *  cpu/memory/storage come from `resources`; only the GPU differs per group. */
  gpuGroups?: GpuSpec[];
};

const DEFAULT_POLL_INTERVAL_MS = 10_000;

function normalizeCpu(input: string): number {
  const num = parseFloat(input.replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : 0.5;
}

// Pricing cap (uact/block — ACT is the deployment-payment denom; uakt pricing
// is no longer accepted on-chain) — providers bid at-or-below this. Setting it
// higher costs nothing unless the bid actually lands above the previous cap
// (lowest bid wins). GPU providers floor much higher than CPU providers, so
// the CPU baseline (env.DEPLOY_PRICING_AMOUNT, ~1000 uact/block) is below most
// GPU providers' floor and produces 0 bids on GPU SDLs.
//
// We don't fetch live pricing — the Console API doesn't expose per-model
// floors. The numbers below are conservative ceilings. NOTE: they were
// calibrated against uakt and carried over unchanged when pricing moved to
// uact — re-validate against live ACT floors, since a ceiling below floor
// silently yields 0 bids. They stay well clear of the chain's max-bid ceiling.
function pricingAmount(gpu: GpuSpec | undefined): number {
  const base = env.DEPLOY_PRICING_AMOUNT;
  if (!gpu) return base;
  const model = gpu.model.toLowerCase();
  // Datacenter / hopper / ada-class — H100/H200/A100/L40/RTX 6000 Pro etc.
  // Provider floor ~$1.50–$3.00/hr (USD). 100,000 ceiling carried over from
  // uakt — re-validate against live ACT floors.
  if (/^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(model)) {
    return Math.max(base, 100_000);
  }
  // Mid-tier consumer / workstation — RTX 4090, RTX 5070, A5000, etc.
  // Provider floor ~$0.30–$1.00/hr (USD). 30,000 ceiling carried over from uakt.
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
  const isJob = (args.executionKind ?? 'service') === 'job';
  // Jobs run the Python+CUDA image (which bakes the byte-identical supervisor);
  // services run the lean Bun image.
  const runnerImage = isJob ? await resolvePythonRunnerImage() : await resolveRunnerImage();
  return buildSdlString(args, runnerImage);
}

// Pure SDL emitter — takes the already-resolved runner image so it has no I/O
// and is unit-testable. Emits today's single-group shape by default; when
// `gpuGroups` has 2+ entries it emits the multi-group GPU fan-out: one `fn`
// service under N placement groups, one GPU compute profile each.
export function buildSdlString(args: BuildSdlArgs, runnerImage: string): string {
  const backendBaseUrl = (args.backendBaseUrl ?? env.CODE_HOST_BASE).replace(/\/$/, '');
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const isJob = (args.executionKind ?? 'service') === 'job';

  if (isJob && !args.deploymentId) {
    throw new Error('buildSdl: deploymentId is required for job execution kind');
  }

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
  if (isJob) {
    // EXECUTION_KIND switches the supervisor to run-to-completion mode;
    // DEPLOYMENT_ID scopes the run's /logs + /complete callbacks. Keep in
    // lockstep with RESERVED_ENV_KEYS and the function_variables DB CHECK.
    envVars.push('EXECUTION_KIND=job', `DEPLOYMENT_ID=${args.deploymentId}`);
  }

  // Per-group compute block. cpu/memory/storage are identical across groups;
  // only the GPU model differs. Akash SDL expects:
  //   gpu: { units, attributes: { vendor: { <vendor>: [{ model }] } } }
  // Providers that don't expose this exact model won't bid.
  const computeResourcesFor = (gpu: GpuSpec | undefined): Record<string, unknown> => {
    const r: Record<string, unknown> = {
      cpu: { units: normalizeCpu(args.resources.cpu) },
      memory: { size: normalizeSize(args.resources.memory) },
      storage: { size: normalizeSize(args.resources.storage) },
    };
    if (gpu) {
      r.gpu = {
        units: gpu.units ?? 1,
        attributes: { vendor: { [gpu.vendor]: [{ model: gpu.model }] } },
      };
    }
    return r;
  };

  const service = {
    image: runnerImage,
    expose: [{ port: 3000, as: 80, to: [{ global: true }] }],
    env: envVars,
  };

  const groups = args.gpuGroups;
  if (groups && groups.length >= 2) {
    // Multi-group fan-out. The chain assigns gseq 1..N in ALPHABETICAL order of
    // placement name (chain-sdk SDL.v3Groups sorts the placement keys), so we
    // name the groups g00, g01, … in candidate order — alphabetical order then
    // equals candidate order, and gseq i+1 maps back to candidate[i].
    const compute: Record<string, unknown> = {};
    const placement: Record<string, unknown> = {};
    const deploy: Record<string, unknown> = {};
    groups.forEach((gpu, i) => {
      const g = `g${String(i).padStart(2, '0')}`;
      compute[g] = { resources: computeResourcesFor(gpu) };
      placement[g] = { pricing: { [g]: { denom: 'uact', amount: pricingAmount(gpu) } } };
      deploy[g] = { profile: g, count: 1 };
    });
    return yaml.dump(
      {
        version: '2.0',
        services: { fn: service },
        profiles: { compute, placement },
        deployment: { fn: deploy },
      },
      { noRefs: true, lineWidth: 1000 }
    );
  }

  // Single-group (default; also the sequential GPU-fallback retry path). Use the
  // lone gpuGroups entry when given, else resources.gpu.
  const gpu = groups && groups.length === 1 ? groups[0] : args.resources.gpu;
  return yaml.dump(
    {
      version: '2.0',
      services: { fn: service },
      profiles: {
        compute: { fn: { resources: computeResourcesFor(gpu) } },
        placement: {
          dcloud: { pricing: { fn: { denom: 'uact', amount: pricingAmount(gpu) } } },
        },
      },
      deployment: { fn: { dcloud: { profile: 'fn', count: 1 } } },
    },
    { noRefs: true, lineWidth: 1000 }
  );
}
