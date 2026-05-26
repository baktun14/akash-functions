import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RewriteEntry } from './types.js';

type NextConfig = Record<string, unknown> & {
  rewrites?: () => Promise<unknown> | unknown;
};

export function withAkashFunctions<T extends NextConfig>(config: T): T {
  const originalRewrites = config.rewrites;
  return {
    ...config,
    async rewrites() {
      const akashRewrites = readGeneratedRewrites();
      const existing = typeof originalRewrites === 'function'
        ? await originalRewrites()
        : [];

      if (Array.isArray(existing)) {
        return [...akashRewrites, ...existing];
      }

      if (existing && typeof existing === 'object') {
        const grouped = existing as {
          beforeFiles?: unknown[];
          afterFiles?: unknown[];
          fallback?: unknown[];
        };
        return {
          ...grouped,
          beforeFiles: [...akashRewrites, ...(grouped.beforeFiles ?? [])],
        };
      }

      return akashRewrites;
    },
  };
}

function readGeneratedRewrites(): RewriteEntry[] {
  const file = path.join(process.cwd(), '.akash-functions/rewrites.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as RewriteEntry[];
}
