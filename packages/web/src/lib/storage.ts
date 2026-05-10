// Typed localStorage helpers. Used by the mock api layer + AkashML connection card.

export const SESSION_KEY = 'akash_functions_session_v1';
export const SERVICES_KEY = 'akash_functions_services_v2';
export const AKASHML_KEY = 'akashml_connection_v1';
export const VERSIONS_KEY_PREFIX = 'akash_functions_versions_v1__';
export const VARIABLES_KEY_PREFIX = 'akash_functions_variables_v1__';
export const API_KEYS_KEY = 'akash_functions_api_keys_v1';
export const PROTECTED_ROUTES_KEY_PREFIX = 'akash_functions_protected_routes_v1__';

export function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
