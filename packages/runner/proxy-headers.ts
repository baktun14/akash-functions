export const ORIGIN_TOKEN_HEADER = 'x-akash-origin-token';
export const ORIGIN_TOKEN_QUERY = '__akash_origin';

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  // fetch() rewrites Host for upstream requests. Passing the provider host
  // through would surprise user code that inspects it.
  'host',
  // fetch() regenerates Content-Length from the forwarded body stream.
  'content-length',
]);

export function userCodeProxyHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of input) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) continue;
    if (lowerName === ORIGIN_TOKEN_HEADER) continue;
    headers.set(name, value);
  }
  return headers;
}
