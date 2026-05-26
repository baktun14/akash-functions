# Akash Functions CLI

`akash-functions` deploys framework functions to Akash Functions. The first
target is Vercel-compatible serverless functions, but the CLI is intentionally
named for Akash Functions so other deployment targets can be added later.

## What It Does

For a Next/Vercel app, the CLI can discover:

- `src/pages/api/**/*.ts`
- `src/app/api/**/route.ts`

It bundles each selected route, generates a small compatibility wrapper, uploads
the generated source to Akash Functions, and writes rewrite state so the public
application URL keeps working.

Developers keep writing normal Vercel-style handlers. They do not need to move
code into an Akash-specific functions directory.

## Commands

```bash
akash-functions init
akash-functions discover
akash-functions deploy
akash-functions patch-output
akash-functions doctor
```

### `init`

Creates `akash-functions.config.json` in the app repo.

```bash
npm i -D @akashnetwork/functions
npx akash-functions init
```

### `discover`

Prints the Vercel-compatible routes the CLI can see.

```bash
npx akash-functions discover
```

### `deploy`

Builds, uploads, and deploys selected routes to Akash Functions.

```bash
AKASH_CONSOLE_API_KEY=... npx akash-functions deploy
```

By default, `deploy` waits for each Akash deployment to become live.

```bash
npx akash-functions deploy --wait=false
npx akash-functions deploy --dry-run
```

### `patch-output`

Patches Vercel prebuilt output after `vercel build`.

```bash
vercel build
npx akash-functions deploy
npx akash-functions patch-output
vercel deploy --prebuilt
```

This prepends Akash routes to `.vercel/output/config.json` and removes matching
Vercel function artifacts on a best-effort basis.

### `doctor`

Checks local config, discovered routes, API key presence, and control-plane
reachability.

```bash
npx akash-functions doctor
```

## Configuration

`akash-functions.config.json`:

```json
{
  "project": "my-next-app",
  "target": "vercel",
  "functions": {
    "include": [
      "src/pages/api/**/*.ts",
      "src/app/api/**/route.ts"
    ],
    "exclude": [
      "src/pages/api/trpc/**",
      "src/app/api/auth/**"
    ],
    "env": [
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET"
    ],
    "resources": {
      "cpu": "0.5",
      "memory": "512Mi",
      "storage": "1Gi"
    },
    "wait": true
  }
}
```

If `include` is empty, the CLI discovers all supported Vercel function files and
then applies `exclude`.

## Next.js Rewrites

The CLI writes:

```text
.akash-functions/deployments.json
.akash-functions/rewrites.json
```

Wrap `next.config.js` to prepend those rewrites:

```js
import { withAkashFunctions } from "@akashnetwork/functions/next";

const config = {
  // existing Next config
};

export default withAkashFunctions(config);
```

The browser still calls the original app URL:

```text
https://example.com/api/stripe/webhook
```

Vercel rewrites that request to the stable Akash Functions URL.

## Stable URLs

Each migrated route gets an opaque stable alias:

```text
https://functions.akash.network/i/afn_<random>/api/stripe/webhook
```

The alias resolves to the latest live Akash deployment for that function. The
raw provider ingress URL is not used in application rewrites.

Set this on the control-plane server in production:

```bash
FUNCTIONS_PUBLIC_BASE=https://functions.akash.network
```

## Invocation Security

Vercel-migrated functions are private-by-default behind an origin token.

Generated rewrites include a capability token:

```text
https://functions.akash.network/i/afn_<random>/api/foo?__akash_origin=<token>
```

The alias proxy:

1. Validates the origin token.
2. Returns `404` for missing or invalid tokens.
3. Strips the token from the forwarded URL.
4. Sends the token to the runner as `x-akash-origin-token`.

The runner also validates the token before forwarding to user code. This means
direct hits to the raw Akash provider ingress are rejected unless they include a
valid token.

Management operations are separate from invocation. Creating aliases, updating
code, and deploying new versions require:

```bash
AKASH_CONSOLE_API_KEY=...
```

The server resolves the key to a wallet address and only allows that wallet to
mutate its own functions and aliases.

## Rollovers

The runner uses local blue/green rollovers:

1. Keep the current version serving on the active internal port.
2. Start the candidate version on a standby internal port.
3. Probe the candidate.
4. Switch proxy traffic only after the probe passes.
5. Terminate the old child after traffic has moved.

If the candidate fails, the old version keeps serving.

## Environment Variables

The CLI scans bundled code for `process.env.NAME` and includes matching values
from the current process. You can force additional variables through config:

```json
{
  "functions": {
    "env": ["DATABASE_URL", "STRIPE_WEBHOOK_SECRET"]
  }
}
```

Values are encrypted at rest by the Akash Functions server and delivered to the
runner over the existing runner-authenticated env endpoint.

## Current Limitations

- The first target is Next/Vercel functions only.
- `patch-output` removes Vercel function artifacts on a best-effort basis
  because output paths vary by framework version.
- Complex Next runtime behavior may still need compatibility work, especially
  routes that depend on deep Next internals.
- `.akash-functions/rewrites.json` contains origin-token-bearing URLs. Treat it
  as a generated deployment artifact, not source-controlled application code.
