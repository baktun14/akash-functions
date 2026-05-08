// Resolves a `RUNNER_IMAGE=…:latest` spec to a concrete `…:X.Y.Z` tag at SDL
// build time. Akash rejects floating tags (no reproducibility across the
// provider set), but we still want operators to opt out of manual version
// bumps after every runner release. The trick: keep `:latest` as the env
// value, then look up the most recent `runner-v*` GitHub release and pin to
// that explicit version when emitting the SDL.

import { env } from '../env';

const RELEASES_URL =
  'https://api.github.com/repos/baktun14/akash-functions/releases?per_page=20';
const TAG_PREFIX = 'runner-v';
const CACHE_TTL_MS = 5 * 60_000;

let cached: { resolved: string; at: number } | null = null;
let inflight: Promise<string> | null = null;

export async function resolveRunnerImage(): Promise<string> {
  const spec = env.RUNNER_IMAGE;
  if (!spec.endsWith(':latest')) return spec;

  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.resolved;
  if (inflight) return inflight;

  inflight = lookup(spec)
    .then((resolved) => {
      cached = { resolved, at: Date.now() };
      return resolved;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

async function lookup(spec: string): Promise<string> {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    throw new Error(`runner-image: GitHub releases query failed (${res.status})`);
  }
  const releases = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
  const latest = releases.find(
    (r) => !r.draft && !r.prerelease && r.tag_name?.startsWith(TAG_PREFIX)
  );
  if (!latest?.tag_name) {
    throw new Error(`runner-image: no ${TAG_PREFIX}* release found`);
  }
  const version = latest.tag_name.slice(TAG_PREFIX.length);
  return spec.replace(/:latest$/, `:${version}`);
}
