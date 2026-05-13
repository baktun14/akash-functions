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
  [['k', 'const'], ['v', ' CORS '], ['p', '= { '], ['s', '"Access-Control-Allow-Origin"'], ['p', ': '], ['s', '"*"'], ['p', ' };']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({']],
  [['p', '  '], ['v', 'port'], ['p', ': '], ['v', 'import'], ['p', '.'], ['v', 'meta'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'PORT'], ['p', ' ?? '], ['n', '3000'], ['p', ',']],
  [['p', '  '], ['v', 'routes'], ['p', ': {']],
  [['p', '    '], ['s', '"/"'], ['p', ': () => '], ['k', 'new'], ['t', ' Response'], ['p', '('], ['s', '"Hello world!"'], ['p', ', { '], ['v', 'headers'], ['p', ': '], ['v', 'CORS'], ['p', ' }),']],
  [['p', '    '], ['s', '"/api/health"'], ['p', ': () => '], ['t', 'Response'], ['p', '.'], ['f', 'json'], ['p', '({ '], ['v', 'status'], ['p', ': '], ['s', '"ok"'], ['p', ' }, { '], ['v', 'headers'], ['p', ': '], ['v', 'CORS'], ['p', ' }),']],
  [['p', '  },']],
  [['p', '});']],
];

const jsxCode: TokenLine[] = [
  [['c', '// index.tsx (Bun v1.3 runtime)']],
  [['k', 'const'], ['v', ' page '], ['p', '= () => '], ['s', '`<main class="min-h-screen bg-black text-white">']],
  [['s', '  <h1 class="text-6xl tracking-tight">Hello, Akash.</h1>']],
  [['s', '</main>`'], ['p', ';']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({']],
  [['p', '  '], ['v', 'port'], ['p', ': '], ['v', 'import'], ['p', '.'], ['v', 'meta'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'PORT'], ['p', ' ?? '], ['n', '3000'], ['p', ',']],
  [['p', '  '], ['v', 'fetch'], ['p', ': () => '], ['k', 'new'], ['t', ' Response'], ['p', '('], ['f', 'page'], ['p', '(), { '], ['v', 'headers'], ['p', ': { '], ['s', '"Content-Type"'], ['p', ': '], ['s', '"text/html"'], ['p', ' } }),']],
  [['p', '});']],
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
  [['c', '// index.tsx — Bun v1.3, calls AkashML via fetch (OpenAI-compatible)']],
  [['k', 'const'], ['v', ' AKASHML '], ['p', '= '], ['s', '"https://api.akashml.com/v1"'], ['p', ';']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({']],
  [['p', '  '], ['v', 'port'], ['p', ': '], ['v', 'import'], ['p', '.'], ['v', 'meta'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'PORT'], ['p', ' ?? '], ['n', '3000'], ['p', ',']],
  [['p', '  '], ['v', 'routes'], ['p', ': {']],
  [['p', '    '], ['s', '"/chat"'], ['p', ': { '], ['v', 'POST'], ['p', ': '], ['k', 'async'], ['p', ' ('], ['v', 'req'], ['p', ') => {']],
  [['p', '      '], ['k', 'const'], ['v', ' { prompt } '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'req'], ['p', '.'], ['f', 'json'], ['p', '();']],
  [['p', '      '], ['k', 'const'], ['v', ' r '], ['p', '= '], ['k', 'await'], ['t', ' fetch'], ['p', '('], ['s', '`${AKASHML}/chat/completions`'], ['p', ', {']],
  [['p', '        '], ['v', 'method'], ['p', ': '], ['s', '"POST"'], ['p', ',']],
  [['p', '        '], ['v', 'headers'], ['p', ': {']],
  [['p', '          '], ['v', 'Authorization'], ['p', ': '], ['s', '`Bearer ${process.env.AKASHML_API_KEY}`'], ['p', ',']],
  [['p', '          '], ['s', '"Content-Type"'], ['p', ': '], ['s', '"application/json"'], ['p', ',']],
  [['p', '        },']],
  [['p', '        '], ['v', 'body'], ['p', ': '], ['t', 'JSON'], ['p', '.'], ['f', 'stringify'], ['p', '({']],
  [['p', '          '], ['v', 'model'], ['p', ': '], ['s', '"meta-llama/Llama-3.3-70B-Instruct"'], ['p', ',']],
  [['p', '          '], ['v', 'messages'], ['p', ': [{ '], ['v', 'role'], ['p', ': '], ['s', '"user"'], ['p', ', '], ['v', 'content'], ['p', ': '], ['v', 'prompt'], ['p', ' }],']],
  [['p', '        }),']],
  [['p', '      });']],
  [['p', '      '], ['k', 'const'], ['v', ' { choices } '], ['p', '= '], ['k', 'await'], ['p', ' '], ['v', 'r'], ['p', '.'], ['f', 'json'], ['p', '();']],
  [['p', '      '], ['k', 'return'], ['p', ' '], ['t', 'Response'], ['p', '.'], ['f', 'json'], ['p', '({ '], ['v', 'reply'], ['p', ': '], ['v', 'choices'], ['p', '[0].'], ['v', 'message'], ['p', '.'], ['v', 'content'], ['p', ' });']],
  [['p', '    } },']],
  [['p', '  },']],
  [['p', '});']],
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
    prompt:
      'Build a /chat endpoint backed by AkashML Llama 3.3 70B. ' +
      'Accept { "prompt": "..." } and return the model\'s reply.',
    name: 'llama-chat',
    needsAkashML: true,
    code: gpuCode,
    res: { cpu: '0.25 vCPU', mem: '256 Mi', gpu: 'AkashML' },
  },
};
