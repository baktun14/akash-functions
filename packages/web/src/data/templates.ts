import type { Template, TemplateCategory } from '@shared/types';

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'api',    label: 'APIs' },
  { id: 'web',    label: 'Web' },
  { id: 'worker', label: 'Workers' },
  { id: 'ai',     label: 'AI / ML' },
  { id: 'data',   label: 'Data' },
];

export const TEMPLATES: Template[] = [
  {
    id: 'rest-hono',
    cat: 'api', preset: 'rest',
    icon: 'fn', name: 'REST API · Hono',
    desc: 'Typed routes, CORS, health check. Bun runtime, ready to scale horizontally.',
    runtime: 'Bun 1.3', tags: ['typescript', 'hono'],
  },
  {
    id: 'webhook',
    cat: 'api', preset: 'rest',
    icon: 'send', name: 'Webhook receiver',
    desc: 'HMAC-verified inbound webhook with retry queue and dead-letter.',
    runtime: 'Bun 1.3', tags: ['typescript'],
  },
  {
    id: 'graphql',
    cat: 'api', preset: 'rest',
    icon: 'network', name: 'GraphQL gateway',
    desc: 'Schema-first GraphQL endpoint with persisted queries and depth limits.',
    runtime: 'Bun 1.3', tags: ['typescript', 'apollo'],
  },
  {
    id: 'site-jsx',
    cat: 'web', preset: 'jsx',
    icon: 'web', name: 'Marketing site · JSX',
    desc: 'Server-rendered landing page. Inline Tailwind, dark theme by default.',
    runtime: 'Bun 1.3', tags: ['jsx', 'tailwind'],
  },
  {
    id: 'next-edge',
    cat: 'web', preset: 'jsx',
    icon: 'web', name: 'Next.js · edge handler',
    desc: 'A single Next-style route on the edge. SSR, streaming, no build step.',
    runtime: 'Bun 1.3', tags: ['jsx', 'streaming'],
  },
  {
    id: 'cron-hourly',
    cat: 'worker', preset: 'cron',
    icon: 'cron', name: 'Hourly cron',
    desc: 'Cron expression worker that pings a webhook and writes to a KV store.',
    runtime: 'Bun 1.3', tags: ['cron', 'kv'],
  },
  {
    id: 'queue-worker',
    cat: 'worker', preset: 'cron',
    icon: 'box', name: 'Queue worker',
    desc: 'Long-running consumer for an SQS / Redis Streams / NATS queue.',
    runtime: 'Bun 1.3', tags: ['queue', 'workers'],
  },
  {
    id: 'llama-chat',
    cat: 'ai', preset: 'gpu', akashml: true,
    icon: 'chat', name: 'Llama 3.3 · chat endpoint',
    desc: 'Streaming chat completions backed by AkashML. Token usage forwarded to logs.',
    runtime: 'Bun 1.3', tags: ['llm', 'streaming'],
  },
  {
    id: 'embed',
    cat: 'ai', preset: 'gpu', akashml: true,
    icon: 'cpu', name: 'Embeddings API',
    desc: 'OpenAI-compatible /v1/embeddings proxy to nomic-embed-text on AkashML.',
    runtime: 'Bun 1.3', tags: ['embeddings'],
  },
  {
    id: 'sd',
    cat: 'ai', preset: 'gpu', akashml: true,
    icon: 'image', name: 'Stable Diffusion · text-to-image',
    desc: 'Single-image inference. Returns a signed URL good for 1 hour.',
    runtime: 'Bun 1.3', tags: ['image', 'gpu'],
  },
  {
    id: 'rag',
    cat: 'data', preset: 'gpu', akashml: true,
    icon: 'db', name: 'RAG retriever',
    desc: 'Postgres + pgvector retriever with re-ranking. Plug your own corpus.',
    runtime: 'Bun 1.3', tags: ['rag', 'pgvector'],
  },
  {
    id: 'kv-cache',
    cat: 'data', preset: 'rest',
    icon: 'storage', name: 'KV cache front',
    desc: 'Read-through cache layer for any HTTP origin. Stale-while-revalidate.',
    runtime: 'Bun 1.3', tags: ['cache'],
  },
];
