// Typed wrapper around AkashML's OpenAI-compatible chat completions API.
// Auth: the user's AkashML key is passed in per call (NEVER held server-side).
// Sent as both `x-api-key` and `Authorization: Bearer` to cover whichever
// scheme the upstream is using today — same dual-scheme pattern as
// console-client.ts.
//
// Base URL is hardcoded by intent. The AkashML service is self-serve and the
// URL is the same for every deployer; making it env-driven invites a class of
// "did you set AKASHML_API_BASE?" misconfigurations that has no upside.

const AKASHML_API_BASE = 'https://api.akashml.com/v1';

// Default to DeepSeek-V4-Flash:
//   - No reasoning phase (Qwen/Qwen3.6 burns the entire output budget on
//     internal thinking before any visible content arrives, which feels broken
//     in the chat UI).
//   - Doesn't hallucinate dependencies (Llama-3.3-70B invented an
//     @akashic/logger import on a smoke prompt).
//   - Produces export-shape that matches what the runtime expects
//     (`export default { fetch: app.fetch }`).
//   - Sub-1.2s time-to-first-content-token on a small function prompt.
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

// Used when `GET /v1/models` is unreachable (network blip, upstream down, or
// the user's key is invalid). Keep DEFAULT_MODEL first so it appears at the
// top of the agent's choices.
const FALLBACK_MODELS: readonly string[] = [
  DEFAULT_MODEL,
  'Qwen/Qwen3.6-35B-A3B',
  'Qwen/Qwen3.5-35B-A3B',
  'meta-llama/Llama-3.3-70B-Instruct',
  'moonshotai/Kimi-K2.6',
  'MiniMaxAI/MiniMax-M2.5',
];

// Short TTL so we don't refetch on every chat turn but still pick up new
// models within a minute. Keyed by SHA-256(apiKey) — different users may have
// different visibility, and we never want to leak a list across keys.
const MODELS_CACHE_TTL_MS = 60_000;
type ModelsCacheEntry = { models: readonly string[]; expiresAt: number };
const modelsCache = new Map<string, ModelsCacheEntry>();

async function hashKey(apiKey: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return Buffer.from(buf).toString('hex');
}

export class AkashMLApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

export type ChatCompletionRequestBody = {
  model: string;
  messages: ChatMessage[];
  // OpenAI-compatible knobs; we leave them optional so the route can pass them
  // through if a future client wants temperature/max_tokens control.
  temperature?: number;
  max_tokens?: number;
  // Always true here — the route only consumes the streaming variant. Kept on
  // the body type so callers can't accidentally pass `stream: false`.
  stream: true;
};

export const akashmlApi = {
  /** Hardcoded base URL, exposed for logs/error messages only. */
  base: AKASHML_API_BASE,
  defaultModel: DEFAULT_MODEL,
  /** Static list used when /v1/models is unreachable. */
  fallbackModels: FALLBACK_MODELS,

  // Lists the model IDs the caller's key has access to. The endpoint requires
  // auth; we pass the user's per-request key (same one used for chat). A
  // 60s in-memory cache (keyed by sha256(key)) avoids refetching on every
  // chat turn. Throws AkashMLApiError on a non-2xx status — callers should
  // catch and fall back to `fallbackModels` rather than failing the chat.
  async listModels(apiKey: string, signal?: AbortSignal): Promise<readonly string[]> {
    const cacheKey = await hashKey(apiKey);
    const cached = modelsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.models;

    const res = await fetch(AKASHML_API_BASE + '/models', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
    });

    let payload: unknown = null;
    let text = '';
    try {
      text = await res.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body — leave payload null
    }

    if (!res.ok) {
      const code =
        (payload as { error?: { code?: string }; code?: string })?.error?.code ??
        (payload as { code?: string })?.code ??
        `HTTP_${res.status}`;
      const message =
        (payload as { error?: { message?: string }; message?: string })?.error?.message ??
        (payload as { message?: string })?.message ??
        (text || `${res.status} ${res.statusText || 'AkashML models fetch failed'}`.trim());
      throw new AkashMLApiError(res.status, code, message, payload);
    }

    const data = (payload as { data?: Array<{ id?: string }> })?.data;
    if (!Array.isArray(data)) {
      throw new AkashMLApiError(200, 'BAD_SHAPE', 'AkashML /v1/models returned no data array', payload);
    }
    const models = data
      .map((m) => (typeof m?.id === 'string' ? m.id : null))
      .filter((id): id is string => !!id);

    modelsCache.set(cacheKey, { models, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
    return models;
  },

  // Opens an SSE stream against AkashML's chat completions endpoint and returns
  // the raw `ReadableStream<Uint8Array>` so the caller can pipe it straight to
  // the browser. Throws AkashMLApiError on a non-2xx status.
  async chatCompletionStream(
    apiKey: string,
    body: ChatCompletionRequestBody,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(AKASHML_API_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    // A misconfigured base URL can land us on a CDN edge that returns 200 with
    // an HTML body — `res.ok` would pass but the stream contains zero SSE
    // frames. Reject anything that isn't an SSE stream up front so callers get
    // a clear error instead of an empty-feeling chat.
    const contentType = res.headers.get('content-type') ?? '';
    const isSse = /text\/event-stream/i.test(contentType);
    if (!res.ok || !res.body || !isSse) {
      let payload: unknown = null;
      let text = '';
      try {
        text = await res.text();
        payload = text ? JSON.parse(text) : null;
      } catch {
        // non-JSON body (HTML error page, etc.)
      }
      const code =
        (payload as { error?: { code?: string }; code?: string })?.error?.code ??
        (payload as { code?: string })?.code ??
        (res.ok && !isSse ? 'NOT_SSE' : `HTTP_${res.status}`);
      const fallback =
        !res.ok
          ? text || `${res.status} ${res.statusText || 'AkashML upstream error'}`.trim()
          : `expected text/event-stream, got ${contentType || 'unknown'}`;
      const message =
        (payload as { error?: { message?: string }; message?: string })?.error?.message ??
        (payload as { message?: string })?.message ??
        fallback;
      throw new AkashMLApiError(res.status, code, message, payload);
    }

    return res.body;
  },
};
