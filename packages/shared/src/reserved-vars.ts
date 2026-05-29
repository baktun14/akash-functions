// SDL-injected env vars the runner relies on to find and authenticate against
// the backend. Users cannot set these as function variables — both the API
// (Zod) and the database (CHECK constraint) reject them, and the runner's
// spawn-time env merge gives the SDL-injected value priority as defense in
// depth. Keep this list in sync with packages/server/src/akash/sdl.ts.
export const RESERVED_ENV_KEYS = [
  'FUNCTION_ID',
  'INITIAL_VERSION_ID',
  'BACKEND_BASE_URL',
  'RUNNER_TOKEN',
  'POLL_INTERVAL_MS',
  'PORT',
  // Job (Python-run) execution. EXECUTION_KIND switches the runner into
  // run-to-completion mode; DEPLOYMENT_ID scopes the run's log/complete
  // callbacks. Keep in lockstep with the DB CHECK and sdl.ts.
  'EXECUTION_KIND',
  'DEPLOYMENT_ID',
] as const;

export type ReservedEnvKey = (typeof RESERVED_ENV_KEYS)[number];

export function isReservedEnvKey(key: string): key is ReservedEnvKey {
  return (RESERVED_ENV_KEYS as readonly string[]).includes(key);
}

// POSIX env-var name shape, with a length cap. The DB CHECK constraint
// `function_variables_key_shape` in 0003_*.sql mirrors this regex — keep them
// in sync.
export const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

// Returns null if the key is acceptable, or a user-facing error string.
// One source of truth for both the API route, the backfill script, and the UI.
export function validateVariableKey(key: string): string | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return 'Use uppercase letters, digits, and underscores. Must start with a letter.';
  }
  if (isReservedEnvKey(key)) {
    return `${key} is reserved by the runner and cannot be used.`;
  }
  return null;
}
