# Production deployment

How akash-functions is deployed and what to do once when bootstrapping a
fresh production environment. After bootstrap, every push to `main` is
deployed automatically by GitHub Actions.

## Architecture

- **Database** — Neon Postgres (TLS-enforced, pooled).
- **Server** — `ghcr.io/baktun14/akash-functions-server` running on Akash,
  reachable at `https://api.<domain>` (Cloudflare CNAME → provider hostname).
- **Web** — `ghcr.io/baktun14/akash-functions-web` (nginx + Vite SPA) running
  on Akash, reachable at `https://app.<domain>`.
- **Runners** — per-function leases that fetch user code from the server.

Both server and web run with `count: 1`. The server's URL is pinned by every
running runner's SDL, so it must never change — production updates use
`MsgUpdateDeployment` (rebind) instead of new leases.

## One-time bootstrap

Do this once per environment. After it's done the GitHub Actions workflows
([server-publish.yml](../.github/workflows/server-publish.yml),
[web-publish.yml](../.github/workflows/web-publish.yml)) take over.

### 1. Neon

1. Create a Neon project (Postgres 16).
2. Copy the **pooled** connection string (host contains `-pooler`). It must
   include `?sslmode=require`. Save as the GitHub secret `NEON_DATABASE_URL`.
3. Sanity check: `psql "$NEON_DATABASE_URL" -c 'SHOW ssl;'` → `on`.

### 2. Generate production secrets

```sh
openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
openssl rand -base64 48   # CODE_SIGNING_SECRET
```

Back up `MASTER_ENCRYPTION_KEY` in two places (e.g. 1Password + offline). If
it is lost, every `function_variables` row and every encrypted
`function_versions.source` row becomes unrecoverable.

### 3. Migrate Neon

From your laptop:

```sh
DATABASE_URL="$NEON_DATABASE_URL" npm run db:migrate -w server
```

Migration `0007_mysterious_elektra` adds the four AES-256-GCM source-code
columns as `NOT NULL`. It assumes `function_versions` is empty — fine for
a fresh Neon database. No backfill is needed.

### 4. First production deploy

From your laptop, with the prod Akash wallet's Console API key in env:

```sh
export AKASH_API_KEY=...                          # Console API key
export PROD_DATABASE_URL="$NEON_DATABASE_URL"
export PROD_MASTER_ENCRYPTION_KEY="$MASTER_ENCRYPTION_KEY"
export PROD_CODE_SIGNING_SECRET="$CODE_SIGNING_SECRET"
export PROD_CODE_HOST_BASE="https://api.<domain>"  # final API URL via Cloudflare

# Server (uses initial version 0.1.0 — adjust to match a built tag).
tsx packages/server/scripts/deploy-prod.ts --target=server --tag=0.1.0
# → prints dseq + provider hostname. Save the dseq.

# Web. VITE_API_BASE must already be baked into the published image.
tsx packages/server/scripts/deploy-prod.ts --target=web --tag=0.1.0
# → prints dseq + provider hostname. Save the dseq.
```

### 5. Cloudflare DNS

In the Cloudflare zone for `<domain>`:

- CNAME `api` → server provider hostname (proxied — orange cloud).
- CNAME `app` → web provider hostname (proxied).
- SSL/TLS mode: **Flexible** to start (the provider terminates plain HTTP on
  the global ingress). Switch to **Full** once the provider serves valid TLS.

### 6. GitHub secrets and variables

```sh
gh secret set NEON_DATABASE_URL          # Neon pooled URL
gh secret set MASTER_ENCRYPTION_KEY      # base64 32 bytes
gh secret set CODE_SIGNING_SECRET        # base64 ≥16 bytes
gh secret set AKASH_API_KEY              # Console API key for the prod wallet
gh secret set AKASH_SERVER_DSEQ          # from step 4
gh secret set AKASH_WEB_DSEQ             # from step 4

gh variable set PROD_API_BASE --body "https://api.<domain>"
gh variable set PROD_DOMAIN   --body "<domain>"
```

`GITHUB_TOKEN` is provided automatically by Actions — no action needed.

## What CI does on every merge to `main`

[server-publish.yml](../.github/workflows/server-publish.yml):
1. Computes the next `server-vX.Y.Z` from conventional commits.
2. Builds and pushes the server image to GHCR.
3. Runs `npm run db:migrate -w server` against `NEON_DATABASE_URL`.
   If migration fails, the workflow fails before rebinding (no broken state).
4. Submits `MsgUpdateDeployment` on `AKASH_SERVER_DSEQ` with the new image
   tag. The Akash provider re-pulls the image and restarts the container
   without releasing the lease. `api.<domain>` keeps working throughout.

[web-publish.yml](../.github/workflows/web-publish.yml):
1. Computes the next `web-vX.Y.Z`.
2. Builds the web image with `VITE_API_BASE=$PROD_API_BASE` baked in.
3. Pushes to GHCR.
4. Rebinds the Akash web lease on `AKASH_WEB_DSEQ`.

## Verification after a rollout

```sh
curl https://api.<domain>/api/health
# → {"ok":true,"runner":"ghcr.io/baktun14/akash-functions-runner:X.Y.Z"}

curl -I https://app.<domain>/
# → HTTP/2 200, content-type: text/html
```

Then in the UI: open a function (decrypt path), edit + save (dual-write path),
add a variable (existing variables flow), create a new function (cold deploy
pipeline against Console API).

## Disaster recovery

- **Lost `MASTER_ENCRYPTION_KEY`** — every encrypted `function_variables` and
  `function_versions.source` value is gone forever. There is no rebuild path.
  Restore from the offline backup.
- **Server `dseq` expires or is closed** — re-run `deploy-prod.ts
  --target=server`, update `AKASH_SERVER_DSEQ` and `api.<domain>` CNAME, then
  every existing runner whose lease still has the old URL needs a manual
  rebind. The in-app auto-rebind in
  [packages/server/src/akash/rebind.ts](../packages/server/src/akash/rebind.ts)
  handles this automatically on the next user request that touches the
  function.
