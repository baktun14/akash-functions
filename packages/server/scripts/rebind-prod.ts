// CI-driven rebind. Re-renders the SDL with a new image tag (and current env)
// and submits MsgUpdateDeployment on the existing dseq, preserving the lease
// and ingress URL. Same primitive used by the in-app auto-rebind in
// packages/server/src/akash/rebind.ts; this script is the prod CD entrypoint.
//
// Usage:
//   tsx packages/server/scripts/rebind-prod.ts \
//     --target=server --tag=0.1.1 --dseq=12345
//
// Required env:
//   AKASH_API_KEY  — Console API key for the prod wallet.
//   server target also reads PROD_DATABASE_URL, PROD_MASTER_ENCRYPTION_KEY,
//   PROD_CODE_SIGNING_SECRET, PROD_CODE_HOST_BASE (see deploy-prod.ts).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { consoleApi } from '../src/akash/console-client';
import { renderSdl } from './deploy-prod';

type Target = 'server' | 'web';

function parseArgs(): { target: Target; tag: string; dseq: string } {
  const args = new Map<string, string>();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args.set(m[1]!, m[2]!);
  }
  const target = args.get('target');
  const tag = args.get('tag');
  const dseq = args.get('dseq');
  if (target !== 'server' && target !== 'web') {
    throw new Error('--target=server|web is required');
  }
  if (!tag) throw new Error('--tag=<semver> is required');
  if (!dseq) throw new Error('--dseq=<lease dseq> is required');
  return { target, tag, dseq };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`${name} is required in env`);
  return v;
}

async function main(): Promise<void> {
  const { target, tag, dseq } = parseArgs();
  const apiKey = requireEnv('AKASH_API_KEY');

  const sdl = await renderSdl(target, tag);
  console.log(`[rebind] target=${target} dseq=${dseq} tag=${tag}`);
  await consoleApi.updateDeployment(apiKey, dseq, sdl);
  console.log('[rebind] update submitted. Provider will re-pull and restart.');
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
