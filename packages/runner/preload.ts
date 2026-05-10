// Bun --preload shim loaded before user code starts.
//
// Why this exists: the 2.1.x runner is a reverse proxy on the SDL-exposed
// PORT, and spawns the user process on an internal port via `PORT=<USER_PORT>`.
// User code that reads `process.env.PORT` / `import.meta.env.PORT` lands on
// the internal port naturally. User code that hardcodes `Bun.serve({ port: 3000 })`
// would try to bind the same port as the runner, collide, and crash the
// container.
//
// Monkey-patching `Bun.serve` here forces any literal port argument to be
// rewritten to `process.env.PORT` (set by the runner to USER_PORT). The user
// code is unaware — its in-process view is identical to running standalone,
// and the proxy in front handles everything external.
//
// Caveats:
//   - Catches `Bun.serve(...)` and `import { serve } from 'bun'` (same global).
//   - Does NOT catch user code that uses `node:http`, Express, or Fastify
//     directly. Those frameworks read `process.env.PORT` by default in
//     practice, so the issue is rare, but a future preload could shim
//     `http.createServer().listen()` if it becomes a problem.

const wantedPort = Number(process.env.PORT);
if (Number.isFinite(wantedPort) && wantedPort > 0) {
  const original = Bun.serve.bind(Bun);
  // The `as any` here is intentional — Bun.serve has overloads that don't
  // line up cleanly with a generic options-rewriting wrapper. The wrapper
  // only mutates `port`; everything else flows through unchanged.
  (Bun as { serve: typeof Bun.serve }).serve = ((opts: unknown, ...rest: unknown[]) => {
    if (
      opts &&
      typeof opts === 'object' &&
      'port' in opts &&
      (opts as { port?: unknown }).port !== wantedPort
    ) {
      const requested = (opts as { port?: unknown }).port;
      console.log(`[runner-preload] rewriting Bun.serve port ${String(requested)} → ${wantedPort}`);
      opts = { ...(opts as object), port: wantedPort };
    }
    return original(opts as Parameters<typeof Bun.serve>[0], ...(rest as []));
  }) as typeof Bun.serve;
}
