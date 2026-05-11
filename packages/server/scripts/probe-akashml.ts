export {};

// Debug probe — verify the AkashML base URL, model id, and SSE shape with a
// real key from DEBUG_AKASHML_KEY in the environment.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/probe-akashml.ts
//
// The key is read from process.env only; this script does not open the .env
// file directly.

const KEY = process.env.DEBUG_AKASHML_KEY;
if (!KEY) {
  console.error('Set DEBUG_AKASHML_KEY in packages/server/.env.local and run with:');
  console.error('  npx tsx --env-file=.env.local scripts/probe-akashml.ts');
  process.exit(1);
}

// Candidate base URLs ranked by what I recall of the AkashML / Akash Chat API.
const CANDIDATE_BASES = [
  'https://chatapi.akash.network/api/v1',
  'https://chatapi.akash.network/v1',
  'https://chat-api.akash.network/api/v1',
  'https://api.akashml.com/v1',
];

// Candidate model ids — first match wins. List should track the live /models
// response on AkashML; update if the lineup changes.
const CANDIDATE_MODELS = [
  'Qwen/Qwen3.6-35B-A3B',
  'meta-llama/Llama-3.3-70B-Instruct',
  'deepseek-ai/DeepSeek-V4-Flash',
  'moonshotai/Kimi-K2.6',
  'MiniMaxAI/MiniMax-M2.5',
  'Qwen/Qwen3.5-35B-A3B',
];

async function maskedHead(res: Response): Promise<string> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!/api[-_]?key|authorization/i.test(k)) headers[k] = v;
  });
  return JSON.stringify(headers);
}

async function probeModelsList(base: string): Promise<{ ok: boolean; models?: string[]; detail?: string }> {
  try {
    const res = await fetch(base + '/models', {
      headers: {
        'x-api-key': KEY!,
        Authorization: `Bearer ${KEY!}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, detail: `${res.status} ${res.statusText} :: ${text.slice(0, 200)}` };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = body.data?.map((m) => m.id).filter(Boolean) ?? [];
    return { ok: true, models: ids };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

async function probeChatNonStream(base: string, model: string) {
  console.log(`\n=== POST ${base}/chat/completions  model=${model} (non-stream) ===`);
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY!,
      Authorization: `Bearer ${KEY!}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
    }),
  });
  console.log(`status=${res.status} ${res.statusText}`);
  console.log(`headers=${await maskedHead(res)}`);
  const text = await res.text();
  console.log(`body=${text.slice(0, 800)}`);
  return { ok: res.ok, body: text };
}

async function probeChatStream(base: string, model: string) {
  console.log(`\n=== POST ${base}/chat/completions  model=${model} (stream) ===`);
  const res = await fetch(base + '/chat/completions', {
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
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      max_tokens: 16,
    }),
  });
  console.log(`status=${res.status} ${res.statusText}`);
  console.log(`headers=${await maskedHead(res)}`);
  if (!res.ok || !res.body) {
    const text = await res.text();
    console.log(`body=${text.slice(0, 800)}`);
    return { ok: false };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let chunkCount = 0;
  const start = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      chunkCount += 1;
      if (chunkCount <= 4 || payload === '[DONE]') {
        console.log(`  chunk#${chunkCount}: ${payload.slice(0, 200)}`);
      }
    }
    if (Date.now() - start > 20_000) {
      console.log('  …aborting after 20s');
      break;
    }
  }
  console.log(`stream finished after ${chunkCount} chunks, ${Date.now() - start}ms`);
  return { ok: true };
}

async function main() {
  console.log(`probing AkashML with key ...${KEY!.slice(-4)} (length=${KEY!.length})\n`);

  let workingBase: string | null = null;
  for (const base of CANDIDATE_BASES) {
    console.log(`--- GET ${base}/models ---`);
    const r = await probeModelsList(base);
    if (r.ok) {
      console.log(`  OK (${r.models?.length ?? 0} models)`);
      console.log(`  first few: ${(r.models ?? []).slice(0, 8).join(', ')}`);
      workingBase = base;
      break;
    }
    console.log(`  not this one: ${r.detail}`);
  }

  if (!workingBase) {
    console.log('\nNo /models endpoint responded OK. Trying chat completions directly…');
    for (const base of CANDIDATE_BASES) {
      const r = await probeChatNonStream(base, CANDIDATE_MODELS[0]!);
      if (r.ok) {
        workingBase = base;
        break;
      }
    }
  }

  if (!workingBase) {
    console.error('\nNo candidate base URL worked. Need a tip from the user on the correct URL.');
    process.exit(2);
  }

  console.log(`\n=== Using base: ${workingBase} ===`);

  // Now pick the first model that returns something for chat completions.
  for (const model of CANDIDATE_MODELS) {
    const r = await probeChatNonStream(workingBase, model);
    if (r.ok) {
      console.log(`\n>>> Working: base=${workingBase} model=${model}`);
      await probeChatStream(workingBase, model);
      process.exit(0);
    }
  }
  console.error('\nBase URL works but none of the candidate models responded OK.');
  process.exit(3);
}

void main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(99);
});
