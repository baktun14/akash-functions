# Akash Functions runner — single image deployed for every function.
# At container boot, fetches user source from BACKEND_BASE_URL using
# RUNNER_TOKEN, then spawns `bun src/index.ts`. A poll loop watches for new
# function versions and hot-swaps /app without re-leasing the deployment.
# SDL injects FUNCTION_ID, INITIAL_VERSION_ID, BACKEND_BASE_URL, RUNNER_TOKEN,
# POLL_INTERVAL_MS, PORT, and (optionally) AKASHML_API_KEY.

FROM oven/bun:1.3-alpine

# Tar is needed to extract the source bundle the backend serves.
RUN apk add --no-cache tar

WORKDIR /app
COPY boot.ts /boot/boot.ts
COPY proxy-headers.ts /boot/proxy-headers.ts
# Preload script loaded by `bun --preload` into the user-code child to rewrite
# hardcoded Bun.serve ports to the internal USER_PORT the runner expects.
COPY preload.ts /boot/preload.ts

ENV PORT=3000
EXPOSE 3000

# Boot script handles fetch → install → spawn user code.
CMD ["bun", "/boot/boot.ts"]
