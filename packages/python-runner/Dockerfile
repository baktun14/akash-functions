# Akash Functions Python+CUDA runner — image for the ephemeral Python GPU
# *job* execution kind. It bakes the SAME Bun supervisor as the standard
# runner (packages/runner/boot.ts + preload.ts), copied in byte-for-byte at
# build time, but on a PyTorch/CUDA base so user code can use the GPU.
#
# At container boot the supervisor reads EXECUTION_KIND=job from the SDL env
# and dispatches to job mode: it fetches the user source from BACKEND_BASE_URL
# using RUNNER_TOKEN, runs `python3 -u main.py` to completion on the GPU,
# streams logs, reports the exit code, then idles. (In server-runner mode the
# very same boot.ts spawns a long-lived Bun server instead.)
#
# IMPORTANT (release coupling): the supervisor source lives in
# packages/runner/, so a change to packages/runner/boot.ts MUST reship this
# image too. The pyrunner-publish workflow triggers on BOTH
# packages/python-runner/** and packages/runner/boot.ts for exactly that
# reason. See packages/python-runner/README.md.
#
# Build context = REPO ROOT (so the COPY lines below can reach
# packages/runner/*). The workflow sets `context: .` and
# `-f packages/python-runner/Dockerfile`. Locally: `npm run build:image`.

# Base pinned by digest (D5 policy). Tag for humans: 2.5.1-cuda12.4-cudnn9-runtime.
# linux/amd64 single-platform image; matches our amd64-only build.
# To re-pin after a base bump:
#   docker manifest inspect -v pytorch/pytorch:<tag> | jq -r '.Descriptor.digest'
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime@sha256:c8268a92a69bd500f8be0e665b2630ee006dadaf7bfbc24249141b15ff622755

# The supervisor shells out to `tar` to extract the code bundle the backend
# serves; ca-certificates so its HTTPS fetch of BACKEND_BASE_URL validates.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tar ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bring in the Bun runtime that runs the supervisor (the PyTorch base has no
# Bun). Copied from the same Bun version the standard runner uses so the
# supervisor behaves identically.
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Byte-identical supervisor, copied from the standard runner package. These
# paths are relative to the REPO ROOT build context (see header).
COPY packages/runner/boot.ts /boot/boot.ts
COPY packages/runner/preload.ts /boot/preload.ts

# Optional GPU-probe entrypoint helper. boot-job.ts may invoke python directly;
# this wrapper exists as the GPU_UNAVAILABLE sentinel mechanism (exit 89).
COPY packages/python-runner/python-launch.sh /usr/local/bin/python-launch.sh
RUN chmod +x /usr/local/bin/python-launch.sh

# pip cache lives under /app so it can be persisted/mounted with the workdir;
# unbuffered Python so job logs stream live to the supervisor.
ENV PIP_CACHE_DIR=/app/.pip-cache \
    PYTHONUNBUFFERED=1

# Kept for parity with the standard runner SDL. Job mode never serves, but the
# SDL still declares the port.
ENV PORT=3000
EXPOSE 3000

# The supervisor reads EXECUTION_KIND=job from the SDL env and dispatches to
# job mode.
CMD ["bun", "/boot/boot.ts"]
