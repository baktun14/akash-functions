import type { DiscoveredRoute } from './types.js';

export function renderEntrypoint(route: DiscoveredRoute): string {
  const factory = route.kind === 'pages-api' ? 'createPagesApiFetch' : 'createAppRouteFetch';
  const compatFile = route.kind === 'pages-api' ? './compat/pages-api.ts' : './compat/app-route.ts';
  return [
    'import * as userModule from "./user-handler.mjs";',
    `import { ${factory} } from "${compatFile}";`,
    '',
    `const handle = ${factory}({`,
    '  module: userModule,',
    `  routePattern: ${JSON.stringify(route.nextPattern)},`,
    '});',
    '',
    'Bun.serve({',
    '  port: Number(process.env.PORT ?? "3000"),',
    '  maxRequestBodySize: 50 * 1024 * 1024,',
    '  fetch: handle,',
    '});',
    '',
  ].join('\n');
}

export const PAGES_API_COMPAT_SOURCE = String.raw`
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

export function createPagesApiFetch(options) {
  const handler = options.module.default;
  if (typeof handler !== "function") {
    throw new Error("Pages API route does not have a default handler export");
  }
  const config = options.module.config ?? {};
  const bodyParser = config?.api?.bodyParser !== false;

  return async function fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const rawBody = methodAllowsBody(method)
      ? Buffer.from(await request.arrayBuffer())
      : Buffer.alloc(0);
    const req = makeRequest(request, url, rawBody, bodyParser, options.routePattern);
    const res = makeResponse();

    try {
      await handler(req, res);
    } catch (err) {
      console.error("[akash-functions] pages api handler failed", err);
      if (!res.headersSent) {
        return jsonResponse({ error: "Internal Server Error" }, 500);
      }
      throw err;
    }

    return res.toResponse();
  };
}

function makeRequest(request, url, rawBody, bodyParser, routePattern) {
  const stream = Readable.from(rawBody);
  const headers = headersObject(request.headers);
  stream.method = request.method;
  stream.url = url.pathname + url.search;
  stream.headers = headers;
  stream.query = {
    ...queryObject(url.searchParams),
    ...matchRouteParams(routePattern, url.pathname),
  };
  stream.cookies = parseCookies(request.headers.get("cookie") ?? "");
  stream.body = bodyParser ? parseBody(rawBody, request.headers.get("content-type") ?? "") : undefined;
  stream.socket = {
    remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
  };
  return stream;
}

function makeResponse() {
  let statusCode = 200;
  let statusMessage = "";
  let ended = false;
  const headers = new Headers();
  const chunks = [];

  const res = {
    get statusCode() { return statusCode; },
    set statusCode(value) { statusCode = Number(value); },
    get statusMessage() { return statusMessage; },
    set statusMessage(value) { statusMessage = String(value ?? ""); },
    get headersSent() { return ended; },
    status(code) {
      statusCode = Number(code);
      return res;
    },
    setHeader(name, value) {
      if (Array.isArray(value)) {
        headers.delete(name);
        for (const item of value) headers.append(name, String(item));
      } else {
        headers.set(name, String(value));
      }
      return res;
    },
    getHeader(name) {
      return headers.get(name) ?? undefined;
    },
    removeHeader(name) {
      headers.delete(name);
      return res;
    },
    writeHead(code, messageOrHeaders, maybeHeaders) {
      statusCode = Number(code);
      if (typeof messageOrHeaders === "string") {
        statusMessage = messageOrHeaders;
        setManyHeaders(headers, maybeHeaders);
      } else {
        setManyHeaders(headers, messageOrHeaders);
      }
      return res;
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(toChunk(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(toChunk(chunk));
      ended = true;
      return res;
    },
    send(value) {
      if (value === undefined || value === null) {
        ended = true;
        return res;
      }
      if (typeof value === "object" && !isBodyLike(value)) {
        return res.json(value);
      }
      chunks.push(toChunk(value));
      ended = true;
      return res;
    },
    json(value) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      chunks.push(Buffer.from(JSON.stringify(value)));
      ended = true;
      return res;
    },
    redirect(statusOrUrl, maybeUrl) {
      const status = typeof statusOrUrl === "number" ? statusOrUrl : 307;
      const location = typeof statusOrUrl === "number" ? maybeUrl : statusOrUrl;
      statusCode = status;
      headers.set("location", String(location));
      ended = true;
      return res;
    },
    toResponse() {
      const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
      return new Response(body, {
        status: statusCode,
        statusText: statusMessage || undefined,
        headers,
      });
    },
  };
  return res;
}

function parseBody(rawBody, contentType) {
  if (rawBody.length === 0) return undefined;
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "application/json" || type === "application/ld+json") {
    return JSON.parse(rawBody.toString("utf8"));
  }
  if (type === "application/x-www-form-urlencoded") {
    return queryObject(new URLSearchParams(rawBody.toString("utf8")));
  }
  if (type?.startsWith("text/")) {
    return rawBody.toString("utf8");
  }
  return rawBody;
}

function headersObject(headers) {
  const out = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (out[lower] === undefined) out[lower] = value;
    else if (Array.isArray(out[lower])) out[lower].push(value);
    else out[lower] = [out[lower], value];
  }
  return out;
}

function queryObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams) {
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function parseCookies(header) {
  const out = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function matchRouteParams(pattern, pathname) {
  const out = {};
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (!part?.startsWith("[") || !part.endsWith("]")) continue;
    if (part.startsWith("[[...")) {
      const key = part.slice(5, -2);
      const rest = pathParts.slice(i);
      if (rest.length > 0) out[key] = rest;
      break;
    }
    if (part.startsWith("[...")) {
      const key = part.slice(4, -1);
      out[key] = pathParts.slice(i);
      break;
    }
    out[part.slice(1, -1)] = pathParts[i] ?? "";
  }
  return out;
}

function setManyHeaders(headers, values) {
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      headers.delete(key);
      for (const item of value) headers.append(key, String(item));
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
}

function toChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}

function isBodyLike(value) {
  return typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodAllowsBody(method) {
  return method !== "GET" && method !== "HEAD";
}
`.trimStart();

export const APP_ROUTE_COMPAT_SOURCE = String.raw`
export function createAppRouteFetch(options) {
  return async function fetch(request) {
    const method = request.method.toUpperCase();
    const handler = options.module[method];
    if (typeof handler !== "function") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: allowedMethods(options.module).join(", ") },
      });
    }
    const params = matchRouteParams(options.routePattern, new URL(request.url).pathname);
    const response = await handler(request, { params });
    if (response instanceof Response) return response;
    if (response === undefined) return new Response(null, { status: 204 });
    return Response.json(response);
  };
}

function allowedMethods(module) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    .filter((method) => typeof module[method] === "function");
}

function matchRouteParams(pattern, pathname) {
  const out = {};
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (!part?.startsWith("[") || !part.endsWith("]")) continue;
    if (part.startsWith("[[...")) {
      const key = part.slice(5, -2);
      const rest = pathParts.slice(i);
      if (rest.length > 0) out[key] = rest;
      break;
    }
    if (part.startsWith("[...")) {
      const key = part.slice(4, -1);
      out[key] = pathParts.slice(i);
      break;
    }
    out[part.slice(1, -1)] = pathParts[i] ?? "";
  }
  return out;
}
`.trimStart();
