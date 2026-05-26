import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_ROUTE_COMPAT_SOURCE,
  PAGES_API_COMPAT_SOURCE,
} from '../src/templates.ts';

test('pages API wrapper maps method, query, params, cookies, body, and response helpers', async () => {
  const { createPagesApiFetch } = await importCompat(PAGES_API_COMPAT_SOURCE);
  const fetchHandler = createPagesApiFetch({
    routePattern: '/api/users/[id]',
    module: {
      default(req: PagesApiRequest, res: PagesApiResponse) {
        res
          .status(201)
          .setHeader('x-route-id', req.query.id)
          .json({
            method: req.method,
            id: req.query.id,
            q: req.query.q,
            cookie: req.cookies.session,
            body: req.body,
            customHeader: req.headers['x-custom'],
          });
      },
    },
  });

  const response = await fetchHandler(new Request('https://example.com/api/users/42?q=search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'session=abc123',
      'x-custom': 'kept',
    },
    body: JSON.stringify({ hello: 'world' }),
  }));

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-route-id'), '42');
  assert.deepEqual(await response.json(), {
    method: 'POST',
    id: '42',
    q: 'search',
    cookie: 'abc123',
    body: { hello: 'world' },
    customHeader: 'kept',
  });
});

test('app route wrapper dispatches by method and passes route params', async () => {
  const { createAppRouteFetch } = await importCompat(APP_ROUTE_COMPAT_SOURCE);
  const fetchHandler = createAppRouteFetch({
    routePattern: '/api/items/[id]',
    module: {
      async POST(request: Request, context: { params: Record<string, string> }) {
        return Response.json(
          {
            id: context.params.id,
            body: await request.json(),
          },
          { status: 202 },
        );
      },
    },
  });

  const response = await fetchHandler(new Request('https://example.com/api/items/abc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: 2 }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    id: 'abc',
    body: { count: 2 },
  });

  const rejected = await fetchHandler(new Request('https://example.com/api/items/abc', {
    method: 'GET',
  }));
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'POST');
});

type CompatModule = {
  createPagesApiFetch: (options: unknown) => (request: Request) => Promise<Response>;
  createAppRouteFetch: (options: unknown) => (request: Request) => Promise<Response>;
};

type PagesApiRequest = {
  method: string;
  query: Record<string, string>;
  cookies: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[]>;
};

type PagesApiResponse = {
  status(code: number): PagesApiResponse;
  setHeader(name: string, value: string): PagesApiResponse;
  json(value: unknown): PagesApiResponse;
};

async function importCompat(source: string): Promise<CompatModule> {
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`) as Promise<CompatModule>;
}
