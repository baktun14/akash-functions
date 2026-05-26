# Akash Functions CLI for Vercel Functions

The CLI binary is `akash-functions`. Vercel is the first deployment target, not
the product name.

## Goal

Developers keep writing normal Vercel-compatible functions:

- `src/pages/api/**/*.ts`
- `src/app/api/**/route.ts`

The CLI discovers those routes, generates Akash runner source with a
Next/Vercel compatibility adapter, upserts each route into Akash Functions, and
writes rewrite state for the frontend deployment.

## Basic flow

```bash
npm i -D @akashnetwork/functions
export AKASH_CONSOLE_API_KEY=...
npx akash-functions init
npx akash-functions deploy
```

`init` writes `akash-functions.config.json`.

`deploy` writes:

```text
.akash-functions/deployments.json
.akash-functions/rewrites.json
```

Wrap `next.config.js` so generated rewrites are prepended as `beforeFiles`
rewrites:

```js
import { withAkashFunctions } from "@akashnetwork/functions/next";

export default withAkashFunctions(config);
```

## Stable URLs and invocation security

The server creates one opaque alias per migrated route:

```text
https://functions.akash.network/i/afn_<random>/api/...
```

`FUNCTIONS_PUBLIC_BASE` controls the public base URL used in CLI responses.

Vercel rewrites include an origin token:

```text
https://functions.akash.network/i/afn_<random>/api/foo?__akash_origin=<token>
```

The alias proxy validates the token, strips it from the forwarded URL, and
passes it to the runner as `x-akash-origin-token`. The runner receives allowed
token hashes from `/api/runner/current/:fnId` and rejects direct provider
ingress calls with `404` unless the token is present. Management operations
still require the Akash Console API key and are scoped to the resolved wallet.

The origin token is stored encrypted at rest and returned to the CLI so CI can
rebuild rewrites idempotently. Treat `.akash-functions/rewrites.json` as a
generated secret-bearing artifact; deploy it, but do not commit it.

## Prebuilt Vercel output

To remove selected functions from Vercel's prebuilt output, run:

```bash
vercel build
npx akash-functions deploy
npx akash-functions patch-output
vercel deploy --prebuilt
```

`patch-output` prepends external Akash routes to `.vercel/output/config.json`
and removes matching `.vercel/output/functions/**/*.func` artifacts on a
best-effort basis.

## Rollovers

The Akash runner now does local blue/green rollovers for code and env updates:

1. Keep the current child process serving on the active internal port.
2. Start the new version on the standby internal port.
3. Probe the new version.
4. Switch proxy traffic only after the probe passes.
5. Terminate the old child after traffic has moved.

If the candidate version fails health checks, the old child keeps serving and
the runner ignores that broken version until a newer version appears.
