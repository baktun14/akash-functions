// Stable invocation aliases.
//
// /i/:publicId/* is the public edge for Vercel-compatible deployments. It
// validates the per-alias origin token, strips it from the public URL, resolves
// the latest live Akash provider ingress, and forwards the request with the
// token in an internal header so the runner can reject direct provider hits.

import { and, desc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { toFetchUrl } from '../akash/reconciler';
import { db } from '../db/client';
import { deployments, functionAliases } from '../db/schema';
import {
  hashOriginToken,
  ORIGIN_TOKEN_HEADER,
  ORIGIN_TOKEN_QUERY,
  timingSafeHexEqual,
} from '../lib/origin-token';

export const aliasRouter = new Hono();

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'host',
  'content-length',
]);

aliasRouter.all('/:publicId', handleAliasRequest);
aliasRouter.all('/:publicId/*', handleAliasRequest);

async function handleAliasRequest(c: Context) {
  const rawPublicId = c.req.param('publicId');
  if (!rawPublicId) return notFound();
  const publicId = rawPublicId;
  const url = new URL(c.req.raw.url);
  const token = c.req.header(ORIGIN_TOKEN_HEADER) ?? url.searchParams.get(ORIGIN_TOKEN_QUERY);

  const [alias] = await db
    .select()
    .from(functionAliases)
    .where(eq(functionAliases.publicId, publicId))
    .limit(1);
  if (!alias) return notFound();

  if (alias.exposure === 'vercel-rewrite') {
    if (!token) return notFound();
    const candidate = hashOriginToken(token);
    if (!timingSafeHexEqual(alias.originTokenHash, candidate)) return notFound();
  }

  const [dep] = await db
    .select()
    .from(deployments)
    .where(and(
      eq(deployments.functionId, alias.functionId),
      eq(deployments.state, 'live'),
      isNull(deployments.closedAt)
    ))
    .orderBy(desc(deployments.liveAt), desc(deployments.createdAt))
    .limit(1);

  const uri = dep?.uris?.[0];
  if (!uri) {
    return new Response('Function unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '3' },
    });
  }

  url.searchParams.delete(ORIGIN_TOKEN_QUERY);
  const upstream = new URL(aliasTargetPath(url, publicId), toFetchUrl(uri).replace(/\/$/, ''));
  const headers = new Headers();
  for (const [name, value] of c.req.raw.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === ORIGIN_TOKEN_HEADER) continue;
    headers.set(name, value);
  }
  if (token) headers.set(ORIGIN_TOKEN_HEADER, token);
  headers.set('x-akash-functions-alias', publicId);

  const method = c.req.method.toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = {
    method: c.req.method,
    headers,
    body: methodAllowsBody(method) ? c.req.raw.body : undefined,
    redirect: 'manual',
    duplex: 'half',
  };
  const res = await fetch(upstream, init);
  const outHeaders = new Headers();
  for (const [name, value] of res.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    outHeaders.set(name, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
}

function aliasTargetPath(url: URL, publicId: string): string {
  const prefix = `/i/${publicId}`;
  const path = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : '/';
  const pathname = path.startsWith('/') ? path : `/${path}`;
  return `${pathname || '/'}${url.search}`;
}

function methodAllowsBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}
