// /api/agent/chat — proxy to AkashML's OpenAI-compatible chat completions
// endpoint. The user's AkashML key arrives in the request body and is forwarded
// upstream verbatim. The route never persists or logs the key.
//
// On the wire we expose a tiny, intent-named SSE protocol (`AgentChatChunk`)
// rather than re-streaming raw OpenAI deltas, so the browser doesn't need to
// know upstream schema and we can swap providers later without a client churn.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  AgentChatChunk,
  AgentChatContext,
  AgentChatMessage,
  AgentChatRequest,
} from '@shared/types';
import { akashmlApi, AkashMLApiError, type ChatMessage } from '../akashml/client';
import { type AuthVars, requireAkashKey } from '../middleware/auth';
import { log } from '../lib/log';

export const agentRouter = new Hono<{ Variables: AuthVars }>();
agentRouter.use('*', requireAkashKey);

function buildSystemPrompt(context: AgentChatContext): string {
  const base =
    'You are an assistant that writes Bun + TypeScript source for the Akash Functions runtime. ' +
    'Guidelines:\n' +
    '- Use Hono for HTTP, Croner for scheduled tasks.\n' +
    '- The entry file is src/index.ts and must `export default app` (a Hono app) or `export default { fetch }`.\n' +
    '- Read env vars via `process.env` (or `Bun.env`); AKASHML_API_KEY is injected when the function needs AkashML.\n' +
    `- AkashML integration: the ONLY correct base URL is "${akashmlApi.base}". Never use any other host (chatapi.akash.network, chat-api.akash.network, api.openai.com, etc.) — those will not work.\n` +
    `- Construct \`new OpenAI({ apiKey: process.env.AKASHML_API_KEY, baseURL: "${akashmlApi.base}" })\` LAZILY inside the request handler (or memoized via a getter) — NEVER at module top level. The OpenAI SDK throws "Missing credentials" during construction when the key is empty/undefined, and at top level that crashes the whole function before any route can respond.\n` +
    `- NEVER write \`process.env.AKASHML_API_KEY || ""\` or any empty-string fallback for credentials — the empty string hits the same SDK validation as undefined and crashes construction. If you want a guard, branch inside the handler: \`if (!process.env.AKASHML_API_KEY) return c.json({ error: "AKASHML_API_KEY not set" }, 500);\`.\n` +
    '- When the user asks for code, emit ONE fenced ```ts code block that is the full file contents — no diffs, no partial snippets. Keep prose outside the block short.\n' +
    '- Do not invent dependencies; stick to hono, croner, openai (for AkashML), and the standard Bun/Node runtime.';

  if (context.mode === 'create') {
    return (
      base +
      `\n\nThe user is creating a new function from the "${context.preset}" preset` +
      (context.name ? ` named "${context.name}"` : '') +
      '. The current editor contents are:\n\n```ts\n' +
      context.currentSource +
      '\n```'
    );
  }
  if (context.mode === 'edit') {
    return (
      base +
      `\n\nThe user is editing function "${context.functionName}" (file: ${context.primaryPath}). The current editor contents are:\n\n` +
      '```ts\n' +
      context.currentSource +
      '\n```'
    );
  }
  return base + '\n\nThe user has no editor open yet — any code you emit will seed a new function.';
}

function toUpstreamMessages(messages: AgentChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// Pulls `data: …` events out of a buffer, returning parsed event payloads
// (or the sentinel `[DONE]`) and the leftover incomplete tail. OpenAI/AkashML
// only use `data:` lines, so we ignore `event:`/`id:` framing.
type SseEvent = { kind: 'data'; payload: string } | { kind: 'done' };
function drainSseFrames(buf: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buf;
  let sep: number;
  while ((sep = rest.indexOf('\n\n')) !== -1) {
    const frame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        events.push({ kind: 'done' });
      } else {
        events.push({ kind: 'data', payload });
      }
    }
  }
  return { events, rest };
}

type OpenAiChunk = {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
};

agentRouter.post('/chat', async (c) => {
  let body: AgentChatRequest;
  try {
    body = (await c.req.json()) as AgentChatRequest;
  } catch {
    return c.json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body' } }, 400);
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing body' } }, 400);
  }
  if (!body.akashmlKey || typeof body.akashmlKey !== 'string') {
    return c.json(
      { error: { code: 'AKASHML_KEY_MISSING', message: 'akashmlKey is required' } },
      400
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      { error: { code: 'MESSAGES_REQUIRED', message: 'messages array is required' } },
      400
    );
  }

  const context: AgentChatContext = body.context ?? { mode: 'none' };
  const model = body.model ?? akashmlApi.defaultModel;
  const systemPrompt = buildSystemPrompt(context);

  return streamSSE(c, async (sse) => {
    const send = (chunk: AgentChatChunk) => sse.writeSSE({ data: JSON.stringify(chunk) });

    const startedAt = Date.now();
    log.info('agent chat upstream calling', {
      model,
      contextMode: context.mode,
      messageCount: body.messages.length,
      base: akashmlApi.base,
    });

    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await akashmlApi.chatCompletionStream(body.akashmlKey, {
        model,
        stream: true,
        // Qwen reasoning models spend output tokens on the thinking phase
        // before emitting visible content. A small cap leaves the user staring
        // at "Thinking…" with no result — generous default so a full function
        // file can stream through reasoning + content + closing tokens.
        max_tokens: 4096,
        messages: [{ role: 'system', content: systemPrompt }, ...toUpstreamMessages(body.messages)],
      });
    } catch (err) {
      const message =
        err instanceof AkashMLApiError
          ? `AkashML ${err.status} ${err.code}: ${err.message}`
          : err instanceof Error
          ? err.message
          : 'AkashML upstream call failed';
      log.warn('agent chat upstream failed', {
        // never include the key
        model,
        contextMode: context.mode,
        elapsedMs: Date.now() - startedAt,
        err: message,
      });
      await send({ type: 'error', message });
      await send({ type: 'done' });
      return;
    }
    log.info('agent chat upstream connected', {
      model,
      elapsedMs: Date.now() - startedAt,
    });

    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let deltaCount = 0;
    let charCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, rest } = drainSseFrames(buf);
        buf = rest;
        for (const ev of events) {
          if (ev.kind === 'done') {
            await send({ type: 'done' });
            log.info('agent chat stream done', {
              model,
              elapsedMs: Date.now() - startedAt,
              deltaCount,
              charCount,
            });
            return;
          }
          try {
            const parsed = JSON.parse(ev.payload) as OpenAiChunk;
            const text = parsed.choices?.[0]?.delta?.content ?? '';
            if (text) {
              deltaCount += 1;
              charCount += text.length;
              await send({ type: 'delta', text });
            }
          } catch {
            // skip malformed event
          }
        }
      }
      await send({ type: 'done' });
      log.info('agent chat stream ended without [DONE]', {
        model,
        elapsedMs: Date.now() - startedAt,
        deltaCount,
        charCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'stream interrupted';
      log.warn('agent chat stream interrupted', {
        err: message,
        elapsedMs: Date.now() - startedAt,
        deltaCount,
      });
      await send({ type: 'error', message });
      await send({ type: 'done' });
    } finally {
      reader.releaseLock();
    }
  });
});
