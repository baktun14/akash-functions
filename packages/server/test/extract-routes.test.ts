import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractRoutes } from '../src/routes/extract-routes.ts';

test('extractRoutes detects framework route calls with body shapes', () => {
  const routes = extractRoutes({
    'src/index.ts': `
      app.get("/health", (c) => c.json({ ok: true }));
      app.post("/chat", async (c) => {
        const { messages, model: requestedModel } = await c.req.json();
        await client.chat.completions.create({ messages, model: requestedModel });
        return c.json({ ok: true });
      });
      app.patch("/todos/:id", async (c) => {
        const body = await c.req.json();
        return c.json({ title: body.title, done: body.done });
      });
      // app.delete("/commented", () => {});
    `,
  });

  assert.deepEqual(routes, [
    { method: 'GET', path: '/health' },
    {
      method: 'POST',
      path: '/chat',
      body: {
        messages: [{ role: 'user', content: 'Hello' }],
        model: '...',
      },
    },
    {
      method: 'PATCH',
      path: '/todos/:id',
      body: {
        title: '...',
        done: '...',
      },
    },
  ]);
});

test('extractRoutes detects Bun.serve declarative routes', () => {
  const routes = extractRoutes({
    'src/index.ts': `
      Bun.serve({
        routes: {
          "/": () => new Response("ok"),
          "/users/:id": {
            GET: () => Response.json({ ok: true }),
            DELETE: () => new Response(null, { status: 204 }),
            POST: async (req) => {
              const { name } = await req.json();
              return Response.json({ name });
            },
          },
        },
      });
    `,
  });

  assert.deepEqual(routes, [
    { method: 'GET', path: '/' },
    { method: 'GET', path: '/users/:id' },
    { method: 'DELETE', path: '/users/:id' },
    {
      method: 'POST',
      path: '/users/:id',
      body: { name: '...' },
    },
  ]);
});
