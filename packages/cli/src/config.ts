import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AkashFunctionsConfig, ResourceConfig } from './types.js';

export const CONFIG_FILE = 'akash-functions.config.json';
export const STATE_DIR = '.akash-functions';
export const DEPLOYMENTS_FILE = 'deployments.json';
export const REWRITES_FILE = 'rewrites.json';

export const DEFAULT_API_BASE = 'https://functions.akash.network';

export const DEFAULT_RESOURCES: ResourceConfig = {
  cpu: '0.5',
  memory: '512Mi',
  storage: '1Gi',
};

export const DEFAULT_CONFIG: AkashFunctionsConfig = {
  target: 'vercel',
  functions: {
    include: [],
    exclude: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
    ],
    resources: DEFAULT_RESOURCES,
    wait: true,
  },
};

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(cwd: string): Promise<AkashFunctionsConfig> {
  const filePath = path.join(cwd, CONFIG_FILE);
  if (!(await pathExists(filePath))) {
    return inferConfig(cwd, DEFAULT_CONFIG);
  }
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as AkashFunctionsConfig;
  return inferConfig(cwd, mergeConfig(DEFAULT_CONFIG, parsed));
}

export async function writeInitialConfig(cwd: string): Promise<string> {
  const pkg = await readJsonIfExists<{ name?: string }>(path.join(cwd, 'package.json'));
  const config: AkashFunctionsConfig = {
    ...DEFAULT_CONFIG,
    project: normalizeProjectName(pkg?.name ?? path.basename(cwd)),
  };
  const filePath = path.join(cwd, CONFIG_FILE);
  if (await pathExists(filePath)) return filePath;
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await mkdir(path.join(cwd, STATE_DIR), { recursive: true });
  return filePath;
}

export async function ensureStateDir(cwd: string): Promise<string> {
  const dir = path.join(cwd, STATE_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function normalizeProjectName(input: string): string {
  return input
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'akash-functions-project';
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await pathExists(filePath))) return null;
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function mergeConfig(base: AkashFunctionsConfig, override: AkashFunctionsConfig): AkashFunctionsConfig {
  return {
    ...base,
    ...override,
    functions: {
      ...base.functions,
      ...override.functions,
      resources: {
        ...DEFAULT_RESOURCES,
        ...base.functions?.resources,
        ...override.functions?.resources,
      },
    },
  };
}

async function inferConfig(
  cwd: string,
  config: AkashFunctionsConfig,
): Promise<AkashFunctionsConfig> {
  if (config.project) return config;
  const pkg = await readJsonIfExists<{ name?: string }>(path.join(cwd, 'package.json'));
  return {
    ...config,
    project: normalizeProjectName(pkg?.name ?? path.basename(cwd)),
  };
}
