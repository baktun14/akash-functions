# Akash Functions runner

Single-image runtime for every function deployed via Akash Functions.

## What it does

1. Container starts. The SDL injects `FUNCTION_ID`, `INITIAL_VERSION_ID`,
   `BACKEND_BASE_URL`, `RUNNER_TOKEN`, `POLL_INTERVAL_MS`, `PORT`, and
   (optionally) `AKASHML_API_KEY`.
2. `boot.ts` fetches the initial version's source from
   `${BACKEND_BASE_URL}/api/runner/code/${FUNCTION_ID}/${INITIAL_VERSION_ID}`
   and extracts it to `/app`.
3. Runs `bun install --production` if a `package.json` is present.
4. Spawns `bun /app/src/index.ts` (or `/app/index.ts`).
5. Forwards `SIGTERM` / `SIGINT` to the child.
6. **Poll loop**: every `POLL_INTERVAL_MS` (default 10s, clamped to
   `[3000, 60000]`), GETs `${BACKEND_BASE_URL}/api/runner/current/${FUNCTION_ID}`.
   On a new `versionId`, stages the new source in `/app.next`, runs
   `bun install` if `package.json` changed, atomically swaps it into `/app`
   (keeping the previous tree as `/app.lkg`), and respawns the user-code child.
7. **Health-checked rollback**: after a swap, waits up to 5s for the new child
   to listen on `PORT`. If it doesn't, restores `/app.lkg` and respawns the
   previous good version.

The image is **public** and **immutable** — every function deploys this exact
image, only the env vars differ. This keeps cold starts predictable, eliminates
per-deploy registry pushes, and lets users update their code without rebuilding
or re-leasing on Akash.

### Known limitation

In-flight requests during the ~50–200ms swap window will see a connection
reset. The Akash provider's ingress should retry idempotent requests; user
code that needs graceful drain should ship a SIGTERM handler that closes its
listener before exit.

## Build & publish

```bash
cd packages/runner
docker build -t ghcr.io/baktun14/akash-functions-runner:2.0.0 .
docker push ghcr.io/baktun14/akash-functions-runner:2.0.0
```

The version tag is referenced by the backend's `RUNNER_IMAGE` env var (default
`ghcr.io/baktun14/akash-functions-runner:2.0.0`). Bump the tag on breaking
changes to the env-var contract; the backend then ships SDL pointing at the
new tag.

## Local smoke test

Start the backend, create a function with a "Hello world" preset, mint a
runner token via the deploy flow, then run:

```bash
docker build -t akash-fns/runner:dev .
docker run --rm -p 3000:3000 \
  -e FUNCTION_ID=fn-abc \
  -e INITIAL_VERSION_ID=v-123 \
  -e BACKEND_BASE_URL=http://host.docker.internal:8081 \
  -e RUNNER_TOKEN=<runner-kind token> \
  -e POLL_INTERVAL_MS=10000 \
  akash-fns/runner:dev
```

Then `curl localhost:3000` should hit your function. Save a new version in the
web UI; within ~10s the runner logs `[reload] swapping <old> → <new>` and the
URL serves the new code.
