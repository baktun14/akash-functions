// Akash SDLs expose `port: 3000, as: 80` — plain HTTP. Most providers don't
// terminate TLS on their global ingress, and the ones that do still serve
// HTTP (typically redirecting to HTTPS). HTTP is the safe default for links.
export function ensureHttpScheme(uri: string): string {
  return uri.startsWith('http') ? uri : `http://${uri}`;
}
