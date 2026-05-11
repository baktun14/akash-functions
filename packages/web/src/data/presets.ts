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
  [['k', 'import'], ['p', ' { '], ['v', 'Cron'], ['p', ' } '], ['k', 'from'], ['s', ' "croner"'], ['p', ';']],
  [],
  [['k', 'new'], ['t', ' Cron'], ['p', '('], ['s', '"0 * * * *"'], ['p', ', '], ['k', 'async'], ['p', ' () => {']],
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
  [['c', '// AKASHML_API_KEY is auto-injected by the AkashML connection']],
  [['k', 'const'], ['v', ' ml '], ['p', '= '], ['k', 'new'], ['t', ' OpenAI'], ['p', '({']],
  [['p', '  '], ['v', 'apiKey'], ['p', ': '], ['v', 'process'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'AKASHML_API_KEY'], ['p', ',']],
  [['p', '  '], ['v', 'baseURL'], ['p', ': '], ['s', '"https://api.akashml.com/v1"'], ['p', ',']],
  [['p', '});']],
  [],
  [['k', 'const'], ['v', ' app '], ['p', '= '], ['k', 'new'], ['t', ' Hono'], ['p', '();']],
  [['v', 'app'], ['p', '.'], ['f', 'post'], ['p', '('], ['s', '"/chat"'], ['p', ', '], ['k', 'async'], ['p', ' ('], ['v', 'c'], ['p', ') => {']],
  [['p', '  '], ['k', 'const'], ['v', ' { messages } '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'c'], ['p', '.'], ['f', 'req'], ['p', '.'], ['f', 'json'], ['p', '();']],
  [['p', '  '], ['k', 'const'], ['v', ' stream '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'ml'], ['p', '.'], ['v', 'chat'], ['p', '.'], ['v', 'completions'], ['p', '.'], ['f', 'create'], ['p', '({']],
  [['p', '    '], ['v', 'model'], ['p', ': '], ['s', '"meta-llama/Llama-3.3-70B-Instruct"'], ['p', ', '], ['v', 'messages'], ['p', ', '], ['v', 'stream'], ['p', ': '], ['k', 'true'], ['p', ',']],
  [['p', '  });']],
  [['p', '  '], ['k', 'return'], ['v', ' c'], ['p', '.'], ['f', 'stream'], ['p', '('], ['v', 'stream'], ['p', '.'], ['f', 'toReadableStream'], ['p', '());']],
  [['p', '});']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({ '], ['v', 'port'], ['p', ': '], ['n', '3000'], ['p', ', '], ['v', 'fetch'], ['p', ': '], ['v', 'app'], ['p', '.'], ['v', 'fetch'], ['p', ' });']],
];

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
    prompt: 'Build a chat endpoint backed by AkashML Llama 3.3 70B. Stream tokens to the client.',
    name: 'llama-chat',
    needsAkashML: true,
    code: gpuCode,
    res: { cpu: '0.25 vCPU', mem: '256 Mi', gpu: 'AkashML' },
  },
};
