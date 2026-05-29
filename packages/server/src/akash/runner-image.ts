// Resolves a `…:latest` image spec to a concrete `…:X.Y.Z` tag at SDL build
// time. Akash rejects floating tags (no reproducibility across the provider
// set), but we still want operators to opt out of manual version bumps after
// every release. The trick: keep `:latest` as the env value, then look up the
// most recent `<prefix>v*` GitHub release and pin to that explicit version when
// emitting the SDL.
//
// Two trains share this machinery: the service runner (`runner-v*`,
// RUNNER_IMAGE) and the Python job runner (`pyrunner-v*`, PYTHON_RUNNER_IMAGE).

import { env } from '../env';
import { log } from '../lib/log';

const RELEASES_URL =
  'https://api.github.com/repos/baktun14/akash-functions/releases?per_page=20';
const CACHE_TTL_MS = 60 * 60_000;

type CacheSlot = { resolved: string; at: number } | null;

// Each train gets its own cache + inflight slot so a stale serve of one doesn't
// pin the other.
const slots: Record<string, { cached: CacheSlot; inflight: Promise<string> | null }> = {};

function slotFor(tagPrefix: string) {
  return (slots[tagPrefix] ??= { cached: null, inflight: null });
}

// Generic resolver: turn `spec` (`…:latest`) into `…:<latest version for
// tagPrefix>`. Non-`:latest` specs pass through untouched.
export async function resolveImage(spec: string, tagPrefix: string): Promise<string> {
  if (!spec.endsWith(':latest')) return spec;

  const slot = slotFor(tagPrefix);
  const now = Date.now();
  if (slot.cached && now - slot.cached.at < CACHE_TTL_MS) return slot.cached.resolved;
  if (slot.inflight) return slot.inflight;

  slot.inflight = lookup(spec, tagPrefix)
    .then((resolved) => {
      slot.cached = { resolved, at: Date.now() };
      return resolved;
    })
    .catch((err) => {
      // Akash providers share egress IPs, so unauthenticated GitHub's
      // 60-req/hr/IP quota burns instantly. If we have a previously-resolved
      // value, serve it stale rather than failing the user's deploy.
      if (slot.cached) {
        log.warn('runner-image: lookup failed, serving stale cache', {
          err: String(err),
          tagPrefix,
          resolved: slot.cached.resolved,
        });
        return slot.cached.resolved;
      }
      throw err;
    })
    .finally(() => {
      slot.inflight = null;
    });

  return slot.inflight;
}

export function resolveRunnerImage(): Promise<string> {
  return resolveImage(env.RUNNER_IMAGE, 'runner-v');
}

export function resolvePythonRunnerImage(): Promise<string> {
  return resolveImage(env.PYTHON_RUNNER_IMAGE, 'pyrunner-v');
}

async function lookup(spec: string, tagPrefix: string): Promise<string> {
  // GitHub rejects requests without a User-Agent with 403, and unauthenticated
  // calls are capped at 60/hr/IP. A token (if available) lifts the cap to
  // 5000/hr — useful in prod where many providers share egress.
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'akash-functions-server',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(RELEASES_URL, { headers });
  if (!res.ok) {
    throw new Error(`runner-image: GitHub releases query failed (${res.status})`);
  }
  const releases = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
  const latest = releases.find(
    (r) => !r.draft && !r.prerelease && r.tag_name?.startsWith(tagPrefix)
  );
  if (!latest?.tag_name) {
    throw new Error(`runner-image: no ${tagPrefix}* release found`);
  }
  const version = latest.tag_name.slice(tagPrefix.length);
  return spec.replace(/:latest$/, `:${version}`);
}
