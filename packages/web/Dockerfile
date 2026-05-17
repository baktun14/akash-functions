# Web image — static SPA built with Vite, served by nginx.
#
# Two stages:
#   1. build — node-alpine installs the workspace, then `npm run build -w web`
#              produces /repo/packages/web/dist. VITE_API_BASE is a build-arg
#              because Vite bakes import.meta.env.* into the JS bundle.
#   2. runtime — nginx-alpine serves dist/ with SPA history fallback.

ARG VITE_API_BASE

FROM node:20-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
COPY packages/runner/package.json ./packages/runner/
COPY packages/releaser/package.json ./packages/releaser/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
ENV VITE_API_MODE=live
RUN npm run build -w web

FROM nginx:alpine AS runtime
COPY --from=build /repo/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
# Cap worker_processes — nginx default `auto` detects the *host's* CPU count,
# not the container's CPU quota, so on an Akash provider with hundreds of cores
# it spawns hundreds of workers for a 0.25 vCPU pod. Workers contend for FDs
# and inotify instances, and the provider's reverse proxy returns 503 because
# the upstream pod is too starved to accept connections.
RUN sed -i 's/^worker_processes.*$/worker_processes 2;/' /etc/nginx/nginx.conf
EXPOSE 80
