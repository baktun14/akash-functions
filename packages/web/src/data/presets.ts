// Preset library for the function builder. Code samples are tokenized for the
// inline syntax-highlighter — see SnippetBlock / CodeBlock for the renderer.
//
// Token format per line: array of [class, text] tuples.
// Empty array = blank line.

import type { CodeSample, Preset, PresetId, TokenLine } from '@shared/types';

export const PRESETS: Preset[] = [
  { id: 'rest', label: 'REST API',         icon: 'fn' },
  { id: 'jsx',  label: 'Website with JSX', icon: 'web' },
  { id: 'cron', label: 'Cron every hour',  icon: 'cron' },
  { id: 'gpu',  label: 'AkashML inference', icon: 'cpu', akash: true },
  { id: 'python', label: 'Python GPU job', icon: 'bolt', akash: true },
];

const restCode: TokenLine[] = [
  [['c', '// index.tsx (Bun v1.3 runtime)']],
  [['k', 'import'], ['p', ' { '], ['v', 'Hono'], ['p', ' } '], ['k', 'from'], ['s', ' "hono@4"'], ['p', ';']],
  [['k', 'import'], ['p', ' { '], ['v', 'cors'], ['p', ' } '], ['k', 'from'], ['s', ' "hono/cors"'], ['p', ';']],
  [],
  [['k', 'const'], ['v', ' app '], ['p', '= '], ['k', 'new'], ['t', ' Hono'], ['p', '();']],
  [],
  [['v', 'app'], ['p', '.'], ['f', 'use'], ['p', '('], ['s', '"/*"'], ['p', ', '], ['f', 'cors'], ['p', '());']],
  [['v', 'app'], ['p', '.'], ['f', 'get'], ['p', '('], ['s', '"/"'], ['p', ', ('], ['v', 'c'], ['p', ') => '], ['v', 'c'], ['p', '.'], ['f', 'text'], ['p', '('], ['s', '"Hello world!"'], ['p', '));']],
  [['v', 'app'], ['p', '.'], ['f', 'get'], ['p', '('], ['s', '"/api/health"'], ['p', ', ('], ['v', 'c'], ['p', ') => '], ['v', 'c'], ['p', '.'], ['f', 'json'], ['p', '({ '], ['v', 'status'], ['p', ': '], ['s', '"ok"'], ['p', ' }));']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({']],
  [['p', '  '], ['v', 'port'], ['p', ': '], ['v', 'import'], ['p', '.'], ['v', 'meta'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'PORT'], ['p', ' ?? '], ['n', '3000'], ['p', ',']],
  [['p', '  '], ['v', 'fetch'], ['p', ': '], ['v', 'app'], ['p', '.'], ['v', 'fetch'], ['p', ',']],
  [['p', '});']],
];

const jsxCode: TokenLine[] = [
  [['c', '// index.tsx (Bun v1.3 runtime)']],
  [['k', 'import'], ['p', ' { '], ['v', 'Hono'], ['p', ' } '], ['k', 'from'], ['s', ' "hono@4"'], ['p', ';']],
  [],
  [['k', 'const'], ['v', ' app '], ['p', '= '], ['k', 'new'], ['t', ' Hono'], ['p', '();']],
  [],
  [['v', 'app'], ['p', '.'], ['f', 'get'], ['p', '('], ['s', '"/"'], ['p', ', ('], ['v', 'c'], ['p', ') => '], ['v', 'c'], ['p', '.'], ['f', 'html'], ['p', '(']],
  [['p', '  ('], ['p', '<'], ['t', 'main'], ['p', ' '], ['v', 'class'], ['p', '='], ['s', '"min-h-screen bg-black text-white"'], ['p', '>']],
  [['p', '    <'], ['t', 'h1'], ['p', ' '], ['v', 'class'], ['p', '='], ['s', '"text-6xl tracking-tight"'], ['p', '>Hello, Akash.</'], ['t', 'h1'], ['p', '>']],
  [['p', '  </'], ['t', 'main'], ['p', '>)']],
  [['p', '));']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({ '], ['v', 'port'], ['p', ': '], ['n', '3000'], ['p', ', '], ['v', 'fetch'], ['p', ': '], ['v', 'app'], ['p', '.'], ['v', 'fetch'], ['p', ' });']],
];

const cronCode: TokenLine[] = [
  [['c', '// index.tsx (Bun v1.3 runtime)']],
  [['t', 'Bun'], ['p', '.'], ['f', 'cron'], ['p', '('], ['s', '"0 * * * *"'], ['p', ', '], ['k', 'async'], ['p', ' () => {']],
  [['p', '  '], ['k', 'const'], ['v', ' res '], ['p', '= '], ['k', 'await'], ['t', ' fetch'], ['p', '('], ['v', 'process'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'WEBHOOK_URL'], ['p', '!);']],
  [['p', '  '], ['v', 'console'], ['p', '.'], ['f', 'log'], ['p', '('], ['s', '"ping"'], ['p', ', '], ['v', 'res'], ['p', '.'], ['v', 'status'], ['p', ');']],
  [['p', '});']],
  [],
  [['c', '// keep the worker alive']],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({ '], ['v', 'port'], ['p', ': '], ['n', '3000'], ['p', ', '], ['v', 'fetch'], ['p', ': () => '], ['k', 'new'], ['t', ' Response'], ['p', '('], ['s', '"ok"'], ['p', ') });']],
];

const gpuCode: TokenLine[] = [
  [['c', '// index.tsx — Bun v1.3, calls AkashML via OpenAI-compatible SDK']],
  [['k', 'import'], ['p', ' { '], ['v', 'Hono'], ['p', ' } '], ['k', 'from'], ['s', ' "hono@4"'], ['p', ';']],
  [['k', 'import'], ['p', ' { '], ['v', 'OpenAI'], ['p', ' } '], ['k', 'from'], ['s', ' "openai"'], ['p', ';']],
  [],
  [['k', 'const'], ['v', ' app '], ['p', '= '], ['k', 'new'], ['t', ' Hono'], ['p', '();']],
  [['v', 'app'], ['p', '.'], ['f', 'post'], ['p', '('], ['s', '"/chat"'], ['p', ', '], ['k', 'async'], ['p', ' ('], ['v', 'c'], ['p', ') => {']],
  [['p', '  '], ['c', '// AKASHML_API_KEY is auto-injected; construct the client LAZILY here']],
  [['p', '  '], ['k', 'const'], ['v', ' ml '], ['p', '= '], ['k', 'new'], ['t', ' OpenAI'], ['p', '({ '], ['v', 'apiKey'], ['p', ': '], ['v', 'process'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'AKASHML_API_KEY'], ['p', ', '], ['v', 'baseURL'], ['p', ': '], ['s', '"https://api.akashml.com/v1"'], ['p', ' });']],
  [['p', '  '], ['k', 'const'], ['v', ' { prompt } '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'c'], ['p', '.'], ['f', 'req'], ['p', '.'], ['f', 'json'], ['p', '();']],
  [['p', '  '], ['k', 'const'], ['v', ' completion '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'ml'], ['p', '.'], ['v', 'chat'], ['p', '.'], ['v', 'completions'], ['p', '.'], ['f', 'create'], ['p', '({']],
  [['p', '    '], ['v', 'model'], ['p', ': '], ['s', '"meta-llama/Llama-3.3-70B-Instruct"'], ['p', ',']],
  [['p', '    '], ['v', 'messages'], ['p', ': [{ '], ['v', 'role'], ['p', ': '], ['s', '"user"'], ['p', ', '], ['v', 'content'], ['p', ': '], ['v', 'prompt'], ['p', ' }],']],
  [['p', '  });']],
  [['p', '  '], ['k', 'return'], ['v', ' c'], ['p', '.'], ['f', 'json'], ['p', '({ '], ['v', 'reply'], ['p', ': '], ['v', 'completion'], ['p', '.'], ['v', 'choices'], ['p', '[0].'], ['v', 'message'], ['p', '.'], ['v', 'content'], ['p', ' });']],
  [['p', '});']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({ '], ['v', 'port'], ['p', ': '], ['n', '3000'], ['p', ', '], ['v', 'fetch'], ['p', ': '], ['v', 'app'], ['p', '.'], ['v', 'fetch'], ['p', ' });']],
];

const pythonSource = `# main.py — runs to completion on a GPU, then tears down.
import torch

print("== GPU info ==")
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("Device:", torch.cuda.get_device_name(0))

# Tiny matmul to prove the GPU is doing work.
a = torch.randn(4096, 4096, device="cuda")
b = torch.randn(4096, 4096, device="cuda")
c = a @ b
torch.cuda.synchronize()
print("matmul result sum:", float(c.sum()))
print("Done.")
`;

const pythonCode: TokenLine[] = pythonSource
  .split('\n')
  .map((line) =>
    line === ''
      ? []
      : line.startsWith('#')
        ? [['c', line] as const]
        : [['v', line] as const]
  );

export const SAMPLES: Record<PresetId, CodeSample> = {
  rest: {
    prompt:
      'Create a REST API that returns "Hello world". Make sure it has a health check endpoint and CORS enabled.',
    name: 'function-bun',
    code: restCode,
    res: { cpu: '0.5 vCPU', mem: '512 Mi', gpu: 'no GPU' },
  },
  jsx: {
    prompt: 'Render a marketing landing page with JSX. Inline tailwind, dark theme.',
    name: 'site-jsx',
    code: jsxCode,
    res: { cpu: '0.25 vCPU', mem: '256 Mi', gpu: 'no GPU' },
  },
  cron: {
    prompt: 'Run a cron every hour that pings a webhook and writes to a KV store.',
    name: 'hourly-cron',
    code: cronCode,
    res: { cpu: '0.25 vCPU', mem: '256 Mi', gpu: 'no GPU' },
  },
  gpu: {
    prompt:
      'Build a /chat endpoint backed by AkashML Llama 3.3 70B. ' +
      'Accept { "prompt": "..." } and return the model\'s reply.',
    name: 'llama-chat',
    needsAkashML: true,
    code: gpuCode,
    res: { cpu: '0.25 vCPU', mem: '256 Mi', gpu: 'AkashML' },
  },
  python: {
    prompt:
      'Run a Python script on an H100 that prints GPU info and does a small ' +
      'torch matmul, then exits.',
    name: 'gpu-job',
    code: pythonCode,
    source: pythonSource,
    res: { cpu: '4 vCPU', mem: '16 Gi', gpu: 'nvidia h100' },
  },
};

// requirements.txt that ships with the python sample's source map.
export const PYTHON_REQUIREMENTS = 'torch\n';
