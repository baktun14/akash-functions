#!/bin/sh
# GPU-probe entrypoint helper for the Python job runner.
#
# Purpose: before running user code, cheaply confirm the GPU is actually
# visible inside the container. Some providers advertise a GPU but fail to
# expose it to the workload; without this probe the user would see an opaque
# CUDA error deep in their script.
#
# Contract:
#   - If torch.cuda.is_available() is False, exit 89. This is the
#     GPU_UNAVAILABLE sentinel. The runner supervisor (boot.ts job mode) maps
#     exit code 89 to a clear "GPU not visible on this provider" error so the
#     platform can surface it / re-bid elsewhere instead of reporting a generic
#     non-zero exit.
#   - Otherwise exec the requested python invocation, replacing this shell so
#     signals (SIGTERM/SIGINT) reach python directly.
#
# Usage: python-launch.sh main.py [args...]
#
# POSIX sh only — the PyTorch base ships /bin/sh, not bash.

set -eu

# 89 = GPU_UNAVAILABLE sentinel. Keep in sync with the runner supervisor's
# job-mode exit-code mapping.
GPU_UNAVAILABLE=89

if ! python3 -c 'import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)'; then
  echo "python-launch: torch.cuda.is_available() == False — GPU not visible on this provider" >&2
  exit "${GPU_UNAVAILABLE}"
fi

exec python3 -u "$@"
