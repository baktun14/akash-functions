import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type Plugin } from 'esbuild';
import {
  APP_ROUTE_COMPAT_SOURCE,
  PAGES_API_COMPAT_SOURCE,
  renderEntrypoint,
} from './templates.js';
import {
  DEFAULT_RESOURCES,
  pathExists,
  readJsonIfExists,
} from './config.js';
import type {
  AkashFunctionsConfig,
  BuiltFunction,
  DiscoveredRoute,
  ResourceConfig,
} from './types.js';

type PackageJson = {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export async function buildFunctionSource(
  cwd: string,
  route: DiscoveredRoute,
  config: AkashFunctionsConfig,
): Promise<BuiltFunction> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'akash-fn-bundle-'));
  try {
    const outfile = path.join(tmp, 'user-handler.mjs');
    const externalPlugin = await externalPackagesPlugin(cwd);
    await mkdir(path.dirname(outfile), { recursive: true });
    await build({
      absWorkingDir: cwd,
      entryPoints: [route.file],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      plugins: [externalPlugin],
      sourcemap: false,
      logLevel: 'silent',
    });

    const bundledHandler = await readFile(outfile, 'utf8');
    const pkg = await readJsonIfExists<PackageJson>(path.join(cwd, 'package.json'));
    const hasPrisma = await pathExists(path.join(cwd, 'prisma/schema.prisma'));
    const envVars = collectEnvVars(bundledHandler, config);
    const source: Record<string, string> = {
      'package.json': JSON.stringify(functionPackageJson(pkg, hasPrisma), null, 2),
      'src/index.ts': renderEntrypoint(route),
      'src/user-handler.mjs': bundledHandler,
      'src/compat/pages-api.ts': PAGES_API_COMPAT_SOURCE,
      'src/compat/app-route.ts': APP_ROUTE_COMPAT_SOURCE,
    };

    if (hasPrisma) {
      source['prisma/schema.prisma'] = await readFile(path.join(cwd, 'prisma/schema.prisma'), 'utf8');
    }

    return {
      route,
      source,
      envVars,
      resources: config.functions?.resources ?? DEFAULT_RESOURCES,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function externalPackagesPlugin(cwd: string): Promise<Plugin> {
  const aliases = await readTsconfigAliases(cwd);
  return {
    name: 'external-packages-except-tsconfig-aliases',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
        if (isNodeBuiltin(args.path)) return { path: args.path, external: true };
        if (matchesAlias(args.path, aliases)) return undefined;
        if (isRelative(args.path)) return undefined;
        return { path: args.path, external: true };
      });
    },
  };
}

type TsconfigAlias = {
  exact: string;
  prefix?: string;
};

async function readTsconfigAliases(cwd: string): Promise<TsconfigAlias[]> {
  const tsconfig = await readJsoncIfExists<{
    compilerOptions?: {
      paths?: Record<string, string[]>;
    };
  }>(path.join(cwd, 'tsconfig.json'));
  const paths = tsconfig?.compilerOptions?.paths ?? {};
  return Object.keys(paths).map((key) => {
    const star = key.indexOf('*');
    return star >= 0
      ? { exact: key.slice(0, star), prefix: key.slice(0, star) }
      : { exact: key };
  });
}

async function readJsoncIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await pathExists(filePath))) return null;
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(stripJsonComments(raw)) as T;
}

function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaping = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    const next = input[i + 1] ?? '';

    if (inString) {
      out += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }
  return out;
}

function matchesAlias(specifier: string, aliases: TsconfigAlias[]): boolean {
  return aliases.some((alias) => {
    if (alias.prefix) return specifier.startsWith(alias.prefix);
    return specifier === alias.exact;
  });
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:');
}

function functionPackageJson(pkg: PackageJson | null, hasPrisma: boolean): PackageJson {
  const dependencies = { ...(pkg?.dependencies ?? {}) };
  if (hasPrisma && pkg?.devDependencies?.prisma && !dependencies.prisma) {
    dependencies.prisma = pkg.devDependencies.prisma;
  }
  return {
    type: 'module',
    scripts: hasPrisma ? { postinstall: 'prisma generate' } : undefined,
    dependencies,
  };
}

function collectEnvVars(source: string, config: AkashFunctionsConfig): Record<string, string> {
  const names = new Set(config.functions?.env ?? []);
  const dotEnv = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;
  const bracketEnv = /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
  let match: RegExpExecArray | null;
  while ((match = dotEnv.exec(source))) {
    if (match[1]) names.add(match[1]);
  }
  while ((match = bracketEnv.exec(source))) {
    if (match[1]) names.add(match[1]);
  }

  const out: Record<string, string> = {};
  for (const name of names) {
    if (isReservedRuntimeEnv(name)) continue;
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function isReservedRuntimeEnv(name: string): boolean {
  return [
    'FUNCTION_ID',
    'INITIAL_VERSION_ID',
    'BACKEND_BASE_URL',
    'RUNNER_TOKEN',
    'POLL_INTERVAL_MS',
    'PORT',
  ].includes(name);
}
