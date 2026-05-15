// One-shot production deploy bootstrap.
//
// Run ONCE per service (server, web) to create the initial Akash lease. The
// printed `dseq` then becomes a GitHub Actions secret (AKASH_SERVER_DSEQ /
// AKASH_WEB_DSEQ), and CI uses rebind-prod.ts for every subsequent merge to
// preserve the same lease + ingress URL.
//
// Usage:
//   tsx packages/server/scripts/deploy-prod.ts \
//     --target=server --tag=0.1.0
//   tsx packages/server/scripts/deploy-prod.ts \
//     --target=web --tag=0.1.0
//
// Required env (set in your shell before running):
//   AKASH_API_KEY            — Console API key for the prod wallet.
//   server target also reads:
//     PROD_DATABASE_URL      — Neon pooled URL with ?sslmode=require.
//     PROD_MASTER_ENCRYPTION_KEY  — base64 32 bytes; back it up offline.
//     PROD_CODE_SIGNING_SECRET    — base64; ≥ 16 bytes after decode.
//     PROD_CODE_HOST_BASE    — public URL of the API behind Cloudflare.
//                              Example: https://api.<domain>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleApiError, consoleApi, type Lease } from '../src/akash/console-client';

type Target = 'server' | 'web';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TARGETS: Record<
  Target,
  { sdlPath: string; imagePlaceholder: string; imageRepo: string; serviceName: string; deposit: number }
> = {
  server: {
    sdlPath: 'deploy/server.sdl.yaml',
    imagePlaceholder: '__SERVER_IMAGE__',
    imageRepo: 'ghcr.io/baktun14/akash-functions-server',
    serviceName: 'api',
    deposit: 5,
  },
  web: {
    sdlPath: 'deploy/web.sdl.yaml',
    imagePlaceholder: '__WEB_IMAGE__',
    imageRepo: 'ghcr.io/baktun14/akash-functions-web',
    serviceName: 'web',
    deposit: 5,
  },
};

function parseArgs(): { target: Target; tag: string } {
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args.set(m[1]!, m[2]!);
  }
  const target = args.get('target');
  const tag = args.get('tag');
  if (target !== 'server' && target !== 'web') {
    throw new Error('--target=server|web is required');
  }
  if (!tag) throw new Error('--tag=<semver> is required');
  return { target, tag };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`${name} is required in env`);
  return v;
}

export async function renderSdl(target: Target, tag: string): Promise<string> {
  const cfg = TARGETS[target];
  const template = await readFile(path.join(REPO_ROOT, cfg.sdlPath), 'utf8');

  const substitutions: Record<string, string> = {
    [cfg.imagePlaceholder]: `${cfg.imageRepo}:${tag}`,
  };
  if (target === 'server') {
    substitutions['__DATABASE_URL__'] = requireEnv('PROD_DATABASE_URL');
    substitutions['__MASTER_ENCRYPTION_KEY__'] = requireEnv('PROD_MASTER_ENCRYPTION_KEY');
    substitutions['__CODE_SIGNING_SECRET__'] = requireEnv('PROD_CODE_SIGNING_SECRET');
    substitutions['__CODE_HOST_BASE__'] = requireEnv('PROD_CODE_HOST_BASE');
  }

  let rendered = template;
  for (const [token, value] of Object.entries(substitutions)) {
    rendered = rendered.split(token).join(value);
  }

  const leftover = rendered.match(/__[A-Z][A-Z0-9_]+__/);
  if (leftover) {
    throw new Error(`SDL has unsubstituted placeholder: ${leftover[0]}`);
  }
  return rendered;
}

const BID_POLL_INTERVAL_MS = 2000;
const BID_POLL_TIMEOUT_MS = 90_000;
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_TIMEOUT_MS = 240_000;

async function main(): Promise<void> {
  const { target, tag } = parseArgs();
  const apiKey = requireEnv('AKASH_API_KEY');
  const cfg = TARGETS[target];

  const sdl = await renderSdl(target, tag);
  console.log(`[deploy] target=${target} tag=${tag} deposit=$${cfg.deposit}`);

  const created = await consoleApi.createDeployment(apiKey, { sdl, deposit: cfg.deposit });
  console.log(`[deploy] dseq=${created.dseq} tx=${created.signTx.transactionHash}`);

  console.log('[deploy] waiting for bids...');
  const bid = await pollUntil({
    label: 'bids',
    intervalMs: BID_POLL_INTERVAL_MS,
    timeoutMs: BID_POLL_TIMEOUT_MS,
    fn: async () => {
      const bids = await consoleApi.getBids(apiKey, created.dseq);
      const open = bids.filter((b) => b.state === 'open' || b.state === 'active');
      if (open.length === 0) return undefined;
      return open.slice().sort((a, b) => Number(a.price.amount) - Number(b.price.amount))[0];
    },
  });
  console.log(`[deploy] cheapest bid: provider=${bid.id.provider} price=${bid.price.amount}${bid.price.denom}`);

  const lease = await consoleApi.acceptLeases(apiKey, {
    manifest: created.manifest,
    leases: [
      {
        dseq: created.dseq,
        gseq: bid.id.gseq,
        oseq: bid.id.oseq,
        provider: bid.id.provider,
      },
    ],
  });
  const ours = lease.leases[0];
  if (!ours) throw new Error('lease accept returned no leases');
  console.log(`[deploy] lease accepted on ${ours.id.provider}`);

  console.log('[deploy] waiting for service to come up...');
  const uris = await pollUntil({
    label: 'service uris',
    intervalMs: STATUS_POLL_INTERVAL_MS,
    timeoutMs: STATUS_POLL_TIMEOUT_MS,
    fn: async () => {
      const detail = await consoleApi.getDeployment(apiKey, created.dseq);
      const lease = detail.leases.find(
        (l) =>
          l.id.gseq === ours.id.gseq &&
          l.id.oseq === ours.id.oseq &&
          l.id.provider === ours.id.provider
      );
      const svc = lease?.status?.services?.[cfg.serviceName];
      if (svc?.uris && svc.uris.length > 0) return svc.uris;
      return undefined;
    },
  });

  console.log('\n===== DEPLOY COMPLETE =====');
  console.log(`target:   ${target}`);
  console.log(`dseq:     ${created.dseq}   ← save this as AKASH_${target.toUpperCase()}_DSEQ`);
  console.log(`provider: ${ours.id.provider}`);
  console.log('uris:');
  for (const uri of uris) console.log(`  - ${uri}`);
  console.log('\nNext: point Cloudflare DNS at the provider hostname, then');
  console.log(`store dseq=${created.dseq} in GitHub secrets so CI can rebind.`);
}

async function pollUntil<T>(args: {
  label: string;
  intervalMs: number;
  timeoutMs: number;
  fn: () => Promise<T | undefined>;
}): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < args.timeoutMs) {
    try {
      const out = await args.fn();
      if (out !== undefined) return out;
    } catch (err) {
      if (err instanceof ConsoleApiError) {
        console.warn(`[poll ${args.label}] ${err.code}: ${err.message}`);
      } else {
        console.warn(`[poll ${args.label}] ${String(err)}`);
      }
    }
    await new Promise((r) => setTimeout(r, args.intervalMs));
  }
  throw new Error(`timeout waiting for ${args.label}`);
}

// Skip running main() when imported (e.g. by rebind-prod.ts for renderSdl).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
