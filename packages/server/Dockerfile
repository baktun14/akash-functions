# Server image — Hono on Bun, deployed to Akash.
#
# Two stages:
#   1. deps   — node-alpine installs the monorepo via npm (the existing
#               package-lock.json is authoritative). Every workspace's
#               package.json must be present for `npm ci` to resolve the
#               internal `@akash-functions/shared` symlink.
#   2. runtime — bun-alpine runs the server directly from TS source. Bun
#               handles TypeScript + tsconfig `paths` (`@shared/*`) natively;
#               no compile step is needed. `tar` is required by the runner
#               code endpoint (packages/server/src/routes/runner.ts).

FROM node:20-alpine AS deps
WORKDIR /repo

# Workspace manifests must all be present, even ones we won't run, so npm
# resolves the symlinks. Skip postinstall — none of our packages need it and
# they'd just slow the build down.
COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
COPY packages/runner/package.json ./packages/runner/
COPY packages/releaser/package.json ./packages/releaser/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /repo

# `tar` is required by packages/server/src/routes/runner.ts to build the
# code tarball served to runner containers at boot.
RUN apk add --no-cache tar

COPY --from=deps /repo/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081
USER bun
CMD ["bun", "packages/server/src/index.ts"]
