# Akash Functions runner

Single-image runtime for every function deployed via Akash Functions.

## What it does

1. Container starts. SDL injects `FUNCTION_ID`, `VERSION_ID`, `CODE_URL`,
   `CODE_TOKEN`, `PORT`, and (optionally) `AKASHML_API_KEY` as env vars.
2. `boot.ts` fetches the user's source from `CODE_URL` (a signed-URL endpoint
   on the Akash Functions backend), extracts it to `/app`.
3. Runs `bun install --production` if a `package.json` is present.
4. Spawns `bun /app/src/index.ts` (or `/app/index.ts`).
5. Forwards `SIGTERM` / `SIGINT` to the child and exits with its status code.

The image is **public** and **immutable** — every function deploys this exact
image, only the env vars differ. This keeps cold starts predictable, eliminates
per-deploy registry pushes, and lets users update their code without rebuilding.

## Build & publish

```bash
cd packages/runner
docker build -t ghcr.io/akash-fns/runner:1.0.0 .
docker push ghcr.io/akash-fns/runner:1.0.0
```

The version tag is referenced by the backend's `RUNNER_IMAGE` env var (default
`ghcr.io/akash-fns/runner:1.0.0`). Bump the tag on breaking changes; the
backend then ships SDL pointing at the new tag.

## Local smoke test

Start the backend, create a function with a "Hello world" preset, then run:

```bash
docker build -t akash-fns/runner:dev .
docker run --rm -p 3000:3000 \
  -e FUNCTION_ID=fn-abc \
  -e VERSION_ID=v-123 \
  -e CODE_URL=http://host.docker.internal:8080/api/runner/code/fn-abc/v-123 \
  -e CODE_TOKEN=<token from /api/.../deploy> \
  akash-fns/runner:dev
```

Then `curl localhost:3000` should hit your function.
