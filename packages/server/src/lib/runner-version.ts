// Runner-image version the platform expects to see. Bump in lockstep with
// packages/runner/package.json — deployments reporting a lower version on the
// /api/runner/current poll get flagged as outdated and prompted to use the
// in-place "Update runner image" flow.
export const EXPECTED_RUNNER_VERSION = '2.1.0';

// Fresh deployments take up to one poll interval (~10s) to report their
// version. Within this window after `liveAt`, an unknown version is treated as
// "checking" rather than "outdated" so the UI doesn't flicker an "out of date"
// badge on a function that just came up.
const FRESH_DEPLOY_GRACE_MS = 60_000;

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
