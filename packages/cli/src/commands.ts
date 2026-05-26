import path from 'node:path';
import { buildFunctionSource } from './bundle.js';
import {
  DEFAULT_API_BASE,
  loadConfig,
  writeInitialConfig,
} from './config.js';
import { discoverVercelRoutes } from './discovery.js';
import {
  healthCheck,
  trimBase,
  upsertFunction,
  waitForDeploymentVersion,
} from './api.js';
import {
  buildRewrite,
  patchVercelOutput,
  writeDeploymentState,
} from './state.js';
import type {
  DeploymentState,
  RewriteEntry,
  UpsertResponse,
} from './types.js';

type ParsedArgs = {
  command: string;
  cwd: string;
  apiBase?: string;
  dryRun: boolean;
  wait?: boolean;
};

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'init':
      await init(args);
      return;
    case 'discover':
      await discover(args);
      return;
    case 'deploy':
      await deploy(args);
      return;
    case 'doctor':
      await doctor(args);
      return;
    case 'patch-output':
      await patchOutput(args);
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command "${args.command}". Run akash-functions help.`);
  }
}

async function init(args: ParsedArgs): Promise<void> {
  const file = await writeInitialConfig(args.cwd);
  console.log(`Created ${path.relative(args.cwd, file)}`);
  console.log('');
  console.log('Add this to next.config.js to route deployed functions through Akash:');
  console.log('');
  console.log('  import { withAkashFunctions } from "@akashnetwork/functions/next";');
  console.log('  export default withAkashFunctions(config);');
}

async function discover(args: ParsedArgs): Promise<void> {
  const config = await loadConfig(args.cwd);
  const routes = await discoverVercelRoutes(args.cwd, config);
  if (routes.length === 0) {
    console.log('No Vercel-compatible functions found.');
    return;
  }
  for (const route of routes) {
    console.log(`${route.kind.padEnd(9)} ${route.nextPattern.padEnd(36)} ${path.relative(args.cwd, route.file)}`);
  }
}

async function doctor(args: ParsedArgs): Promise<void> {
  const config = await loadConfig(args.cwd);
  const apiBase = args.apiBase ?? config.apiBase ?? process.env.AKASH_FUNCTIONS_API_BASE ?? DEFAULT_API_BASE;
  const apiKey = process.env.AKASH_CONSOLE_API_KEY ?? process.env.AKASH_FUNCTIONS_API_KEY;
  const routes = await discoverVercelRoutes(args.cwd, config);

  console.log(`project: ${config.project}`);
  console.log(`api:     ${apiBase}`);
  console.log(`key:     ${apiKey ? 'present' : 'missing AKASH_CONSOLE_API_KEY'}`);
  console.log(`routes:  ${routes.length}`);
  console.log(`server:  ${(await healthCheck(apiBase)) ? 'reachable' : 'unreachable'}`);
}

async function deploy(args: ParsedArgs): Promise<void> {
  const config = await loadConfig(args.cwd);
  const apiBase = args.apiBase ?? config.apiBase ?? process.env.AKASH_FUNCTIONS_API_BASE ?? DEFAULT_API_BASE;
  const apiKey = process.env.AKASH_CONSOLE_API_KEY ?? process.env.AKASH_FUNCTIONS_API_KEY;
  const wait = args.wait ?? config.functions?.wait ?? true;

  if (!apiKey && !args.dryRun) {
    throw new Error('Missing AKASH_CONSOLE_API_KEY');
  }

  const routes = await discoverVercelRoutes(args.cwd, config);
  if (routes.length === 0) {
    console.log('No Vercel-compatible functions found.');
    return;
  }

  const project = config.project ?? path.basename(args.cwd);
  const deployed: DeploymentState['functions'] = [];
  const rewrites: RewriteEntry[] = [];

  for (const route of routes) {
    console.log(`Building ${route.nextPattern}`);
    const built = await buildFunctionSource(args.cwd, route, config);
    console.log(`Deploying ${route.nextPattern} (${Object.keys(built.envVars).length} env vars)`);
    let response: UpsertResponse = await upsertFunction(
      apiBase,
      apiKey ?? '',
      project,
      built,
      args.dryRun,
    );

    if (!args.dryRun && wait && response.deploymentId) {
      const polled = await waitForDeploymentVersion(
        apiBase,
        apiKey ?? '',
        response.function.id,
        response.deploymentId,
        response.versionId,
      );
      response = {
        ...response,
        ingressUrl: response.ingressUrl ?? polled.uris?.[0],
      };
    }

    const rewrite = buildRewrite(route, response);
    if (rewrite) rewrites.push(rewrite);
    deployed.push({
      name: route.name,
      route: route.nextPattern,
      source: path.relative(args.cwd, route.file),
      functionId: response.function.id,
      versionId: response.versionId,
      deploymentId: response.deploymentId,
      ingressUrl: response.ingressUrl,
      stableUrl: response.stableUrl,
    });
    console.log(`${route.nextPattern} -> ${response.stableUrl ?? response.ingressUrl ?? response.function.id}`);
  }

  await writeDeploymentState(args.cwd, {
    generatedAt: new Date().toISOString(),
    project,
    target: 'vercel',
    functions: deployed,
    rewrites,
  });

  console.log(`Wrote .akash-functions/deployments.json and .akash-functions/rewrites.json`);
  if (rewrites.length === 0 && !args.dryRun) {
    console.log(`No rewrites were generated because no ingress URL was available yet.`);
  }
}

async function patchOutput(args: ParsedArgs): Promise<void> {
  const result = await patchVercelOutput(args.cwd);
  console.log(result.configPatched ? 'Patched .vercel/output/config.json' : 'No output config patched');
  if (result.removedFunctions.length > 0) {
    for (const file of result.removedFunctions) {
      console.log(`Removed ${file}`);
    }
  } else {
    console.log('No matching .vercel/output function artifacts found to remove');
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const parsed: ParsedArgs = {
    command,
    cwd: process.cwd(),
    dryRun: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      parsed.cwd = path.resolve(requiredValue(argv, ++i, arg));
    } else if (arg === '--api-base') {
      parsed.apiBase = trimBase(requiredValue(argv, ++i, arg));
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--wait=false') {
      parsed.wait = false;
    } else if (arg === '--wait') {
      parsed.wait = true;
    } else {
      throw new Error(`Unknown option "${arg}"`);
    }
  }

  return parsed;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`akash-functions

Usage:
  akash-functions init
  akash-functions discover
  akash-functions deploy [--dry-run] [--wait=false]
  akash-functions patch-output
  akash-functions doctor

Environment:
  AKASH_CONSOLE_API_KEY       Akash Console API key used for deployment
  AKASH_FUNCTIONS_API_BASE    Akash Functions API base URL
`);
}
