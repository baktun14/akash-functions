// Runner-image version the platform expects to see. Bump in lockstep with
// packages/runner/package.json — deployments reporting a lower version on the
// /api/runner/current poll get flagged as outdated and prompted to use the
// in-place "Update runner image" flow.
export const EXPECTED_RUNNER_VERSION = '2.4.0';

// Fresh deployments take up to one poll interval (~10s) to report their
// version. Within this window after `liveAt`, an unknown version is treated as
// "checking" rather than "outdated" so the UI doesn't flicker an "out of date"
// badge on a function that just came up.
const FRESH_DEPLOY_GRACE_MS = 60_000;

// A reporting runner that misses ~9 polls (POLL_DEFAULT_MS=10s in
// packages/runner/boot.ts) is considered stale — almost always means the
// container can no longer reach BACKEND_BASE_URL (e.g. dev cloudflared tunnel
// rotated and the SDL still bakes the old hostname).
export const RUNNER_STALE_MS = 90_000;
// A never-reported runner is only treated as stale once the deploy has been
// live past this grace window. Cold-pull on slow networks can legitimately
// take a minute before the first poll lands.
export const RUNNER_STALE_GRACE_MS = 5 * 60_000;

export function isRunnerOutdated(
  reported: string | null | undefined,
  liveAt: Date | null | undefined
): boolean {
  if (reported) {
    return compareSemver(reported, EXPECTED_RUNNER_VERSION) < 0;
  }
  // Never reported. If the deployment has been live longer than the grace
  // window, this is a legacy runner (pre-version-reporting) — flag it.
  if (!liveAt) return false;
  return Date.now() - liveAt.getTime() > FRESH_DEPLOY_GRACE_MS;
}

// True when a live deployment's runner has gone silent on the poll loop. The
// canonical recovery is to push a fresh SDL via /update-image so the provider
// re-pulls with the current BACKEND_BASE_URL.
export function isRunnerStale(
  seenAt: Date | null | undefined,
  liveAt: Date | null | undefined,
  state: string
): boolean {
  if (state !== 'live' || !liveAt) return false;
  const now = Date.now();
  if (seenAt) return now - seenAt.getTime() > RUNNER_STALE_MS;
  return now - liveAt.getTime() > RUNNER_STALE_GRACE_MS;
}

// Returns -1 / 0 / 1. Unparseable inputs compare equal so we never spuriously
// flag a deployment as outdated because its version string was malformed.
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
