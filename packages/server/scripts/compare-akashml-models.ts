export {};

// Side-by-side latency + output quality probe across AkashML models for the
// agent chat use case. Measures:
//   - TTFB (time to first SSE chunk)
//   - TTFC (time to first delta.content — i.e. visible to user)
//   - Whether the model emits delta.reasoning before content
//   - Total time + char count
//   - The actual generated code (truncated)
//
// Usage:
//   npx tsx --env-file=.env.local scripts/compare-akashml-models.ts

const KEY = process.env.DEBUG_AKASHML_KEY;
if (!KEY) {
  console.error('Set DEBUG_AKASHML_KEY in .env.local');
  process.exit(1);
}

const BASE = 'https://api.akashml.com/v1';
const MODELS = [
  'deepseek-ai/DeepSeek-V4-Flash',
  'Qwen/Qwen3.6-35B-A3B',
  'meta-llama/Llama-3.3-70B-Instruct',
];

// A representative agent-chat prompt — write a small Hono function file.
const SYSTEM =
  'You generate Bun + TypeScript source for the Akash Functions runtime. ' +
  'Use Hono for HTTP. Output ONE fenced ```ts code block that is the full file ' +
  'contents — no diffs, no partial snippets. Keep any prose outside the block short.';
const USER = 'create a new function that returns "YO" from a GET /yo endpoint';

type OAChunk = {
  choices?: Array<{
    delta?: { content?: string; reasoning?: string };
    finish_reason?: string | null;
  }>;
};

async function probe(model: string) {
  console.log(`\n=== ${model} ===`);
  const start = Date.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'x-api-key': KEY!,
      Authorization: `Bearer ${KEY!}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    console.log(`  status=${res.status} ${res.statusText}`);
    console.log(`  body=${(await res.text()).slice(0, 200)}`);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ttfb = -1;
  let ttfc = -1;
  let reasoningChars = 0;
  let contentChars = 0;
  let content = '';
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfb === -1) ttfb = Date.now() - start;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as OAChunk;
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.reasoning) reasoningChars += delta.reasoning.length;
        if (delta?.content) {
          if (ttfc === -1) ttfc = Date.now() - start;
          contentChars += delta.content.length;
          content += delta.content;
        }
        const fr = parsed.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
      } catch {
        // skip malformed event
      }
    }
  }
  const total = Date.now() - start;
  console.log(`  ttfb=${ttfb}ms  ttfc=${ttfc}ms  total=${total}ms`);
  console.log(`  reasoning=${reasoningChars}c  content=${contentChars}c  finish=${finishReason}`);
  console.log('  --- content (first 500 chars) ---');
  console.log(content.slice(0, 500).split('\n').map((l) => '    ' + l).join('\n'));
}

async function main() {
  for (const m of MODELS) {
    try {
      await probe(m);
    } catch (err) {
      console.log(`  failed: ${(err as Error).message}`);
    }
  }
}

void main();
