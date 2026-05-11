// Static scan of function source for env-var references so the builder can
// prompt for values before deploy. We look at the entry-file source only —
// the source map only ever has src/index.ts on the create-function path.
//
// System vars (set by the runner's SDL) are filtered out so users don't get
// asked to fill in PORT or RUNNER_TOKEN. Anything else is a user secret the
// runtime won't have unless the user supplies it.

// Mirrors the var names emitted by packages/server/src/akash/sdl.ts. Keeping
// them inline here (rather than importing from server) keeps the web bundle
// independent of the server package.
const SYSTEM_ENV_VARS: ReadonlySet<string> = new Set([
  'PORT',
  'FUNCTION_ID',
  'INITIAL_VERSION_ID',
  'BACKEND_BASE_URL',
  'RUNNER_TOKEN',
  'POLL_INTERVAL_MS',
]);

// `\b(process|Bun)\.env\.<UPPER_KEY>` — only UPPER_SNAKE_CASE keys to match
// what reserved-vars.ts requires for user-supplied variables. Lowercase or
// camelCase accesses (e.g. `process.env.npm_lifecycle_event`) are runtime
// metadata, not user config, so skipping them avoids noise.
const ENV_VAR_RE = /\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)/g;

export function detectEnvVarKeys(source: string): string[] {
  const seen = new Set<string>();
  ENV_VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENV_VAR_RE.exec(source))) {
    const key = m[1];
    if (!key) continue;
    if (SYSTEM_ENV_VARS.has(key)) continue;
    seen.add(key);
  }
  return Array.from(seen);
}
