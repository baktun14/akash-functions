# Akash Functions

A standalone serverless functions platform for Akash Network. Describe a
function in plain English (or pick a template), connect your Akash Console API
key, and the platform deploys a Bun container on Akash and gives you back an
HTTPS URL.

## Architecture

```
packages/
├── shared/        TypeScript types shared across web + server
├── web/           React SPA (Vite)
├── server/        Hono REST API on Node, Drizzle + Postgres
└── runner/        The single Docker image that every function runs in
```

- **shared** — `Session`, `FunctionRecord`, `CodeSample`, `Template`,
  `DeploymentRecord`, etc. The type contract between client and server.
- **web** — Onboarding, Sidebar, TopBar, Functions list, Service detail
  (Deployments / Source Code / Variables / Metrics / Settings tabs),
  FunctionBuilder modal, Templates page, AkashML connection card.
- **server** — Express-style routes for CRUD-on-functions plus a deploy
  pipeline that builds an SDL, hits Akash's Console API on the user's behalf,
  watches bids, accepts the cheapest, and polls until the lease is live.
  Stores function source in Postgres and serves a signed tarball to the runner
  at boot time.
- **runner** — `oven/bun:1.3-alpine` + a tiny `boot.ts` that fetches user code
  from the backend, runs `bun install`, and spawns `bun src/index.ts`. One
  image per Akash deployment — no per-function builds.

## Deploy flow

```
Browser holds Akash Console API key in localStorage
   │  Authorization: Bearer <key>
   ▼
Server (POST /api/functions/:id/deploy)
   │  builds SDL pointing at runner image, with FUNCTION_ID + signed CODE_URL
   ▼
Console API (POST /v1/deployment, polls /v1/bids, /v1/lease, /v1/lease/.../status)
   ▼
Akash provider runs the runner image
   │  GET /api/runner/code/:fnId/:versionId?t=<HMAC>
   ▼
Backend serves user source as a tarball
   │
   ▼
Runner extracts to /app, bun install, spawns user code
```

The user's API key is **never persisted** server-side. We only store
`sha256(key).slice(0,16)` as `ownerHash` for query scoping.

## Quick start

Prereqs: Node ≥ 20, a running Postgres (any local install — see env below for connection string).

```bash
npm install
cp .env.example .env

# Create the database (one-time)
createdb akash_functions

# Generate + run migrations
npm run db:generate
npm run db:migrate

# Run web + server in parallel
npm run dev
```

Web runs on http://localhost:5173, server on http://localhost:8081.

By default the frontend is in **mock mode** (localStorage-backed) — you can
explore the UI without a backend or a real Akash key. Set
`VITE_API_MODE=live` in `packages/web/.env.local` to talk to the real backend.

> Adjust `DATABASE_URL` in `.env` to match your local Postgres credentials.
> Default expects `postgres://baktun14@localhost:5433/akash_functions`.

## Configuration (.env)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | Backend HTTP port |
| `DATABASE_URL` | `postgres://baktun14@localhost:5433/akash_functions` | Postgres connection |
| `AKASH_API_BASE` | `https://console-api.akash.network/v1` | Akash Console API base |
| `RUNNER_IMAGE` | `ghcr.io/baktun14/akash-functions-runner:1.0.0` | Docker image SDL points at |
| `CODE_SIGNING_SECRET` | dev placeholder | HMAC secret for runner code-fetch tokens |
| `CODE_HOST_BASE` | `http://host.docker.internal:8081` | Public host the runner uses to fetch source. **Must be reachable from Akash provider containers** — for local dev, run a tunnel (see below). |
| `DEPLOY_DEPOSIT` | `5000000uakt` | Initial escrow deposit |
| `DEPLOY_PRICING_AMOUNT` | `1000` | uakt/block in the SDL pricing block |
| `VITE_API_BASE` | `http://localhost:8081` | Frontend → backend URL |
| `VITE_API_MODE` | `live` | `live` (real backend + Akash) or `mock` (offline localStorage-only) |

## Deploying for real

Three things must be true before clicking **Deploy** in the UI actually creates a lease on Akash:

1. **The runner image is publicly pullable.** GitHub Actions [`runner-publish.yml`](.github/workflows/runner-publish.yml) builds it on every push to `main` (paths-filtered to `packages/runner/**`) and on `runner-vX.Y.Z` tags. Push a tag to publish:
   ```bash
   git tag runner-v1.0.0 && git push origin runner-v1.0.0
   ```
   GHCR packages default to **private** — after the first publish, flip visibility to **Public** at <https://github.com/users/baktun14/packages/container/akash-functions-runner/settings>.

2. **The server is reachable from Akash provider machines.** The runner fetches source from `${CODE_HOST_BASE}/api/runner/code/...` at boot, so `CODE_HOST_BASE` cannot be `localhost`. For local dev, expose port 8081 with cloudflared and paste the URL into `.env`:
   ```bash
   cloudflared tunnel --url http://localhost:8081
   # → CODE_HOST_BASE=https://<random>.trycloudflare.com
   ```
   The tunnel must stay up the whole time the deployment is live (providers will re-pull source on container restart).

3. **Your Akash wallet has funds.** The pipeline's default deposit is `5000000uakt` (~5 AKT). Top up the wallet behind your Console API key before deploying.

## Workspace scripts

```bash
npm run dev          # web + server in parallel
npm run web          # only web
npm run server       # only server
npm run typecheck    # all packages
npm run db:generate  # drizzle-kit generate
npm run db:migrate   # apply pending migrations
```

## Building the runner image

CI publishes on tag push. To build locally for testing:

```bash
cd packages/runner
docker build -t ghcr.io/baktun14/akash-functions-runner:dev .
```

Bump the tag for breaking changes and update `RUNNER_IMAGE` in the server env.

## Workspace scripts

```bash
npm run dev          # web + server in parallel
npm run web          # only web
npm run server       # only server
npm run typecheck    # all packages
npm run db:generate  # drizzle-kit generate
npm run db:migrate   # apply pending migrations
```

## API surface (server)

| Method + Path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness check |
| `GET /api/functions` | Bearer | List user's functions |
| `POST /api/functions` | Bearer | Create a function (initial code version) |
| `GET /api/functions/:id` | Bearer | Get function record |
| `PUT /api/functions/:id` | Bearer | Rename |
| `PUT /api/functions/:id/code` | Bearer | Submit new code version |
| `DELETE /api/functions/:id` | Bearer | Soft delete + close any live deployment |
| `POST /api/functions/:id/deploy` | Bearer | Kick off deploy pipeline (returns 202) |
| `GET /api/functions/:id/deployments/:depId` | Bearer | Poll deployment state |
| `GET /api/usage` | Bearer | Wallet balance, USD-first |
| `GET /api/runner/code/:fnId/:versionId?t=…` | HMAC | **Public, signed.** Returns source tarball |

## Out of scope (for now)

- Auth beyond bearer-token possession (no accounts, no orgs)
- Wildcard `*.akash-functions.io` ingress proxy — for MVP the URL is whatever the lease returns
- Per-function image builds (Kaniko etc.) — single runner image is the MVP path
- Logs streaming UI
- Stripe / billing on our side — the user's own Akash wallet pays for everything
