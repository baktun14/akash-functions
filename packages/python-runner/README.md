# Akash Functions Python runner

PyTorch + CUDA image for the ephemeral **Python GPU job** execution kind.

## What it is

A GPU-capable sibling of the standard [runner](../runner) image. It bakes the
**byte-identical** Bun supervisor from `packages/runner` (`boot.ts` +
`preload.ts`, copied in at build time) on top of a
`pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime` base.

At boot the supervisor reads `EXECUTION_KIND=job` from the SDL env and
dispatches to **job mode**: it fetches the user source from `BACKEND_BASE_URL`
using `RUNNER_TOKEN`, runs `python3 -u main.py` to completion on the GPU,
streams logs, reports the exit code, then idles. The same `boot.ts` in
server-runner mode spawns a long-lived Bun server instead — there is only one
supervisor, shared across both images.

## Supervisor is copied, not forked

`boot.ts`/`preload.ts` are **not** duplicated in this package. The Dockerfile
copies them from `packages/runner/` so they can never drift from the standard
runner. Because the build needs to reach outside this directory, the **build
context is the repo root** (`docker build -f packages/python-runner/Dockerfile
... .`) and the COPY paths are repo-root-relative
(`COPY packages/runner/boot.ts /boot/boot.ts`).

## Release coupling: boot.ts changes MUST reship this image

Since the supervisor is baked in at build time, a change to
`packages/runner/boot.ts` produces a stale Python runner unless this image is
rebuilt. The publish workflow
([`.github/workflows/pyrunner-publish.yml`](../../.github/workflows/pyrunner-publish.yml))
therefore triggers on **both** `packages/python-runner/**` **and**
`packages/runner/boot.ts` (and `preload.ts`), cutting a `pyrunner-v*` tag and
publishing `ghcr.io/baktun14/akash-functions-python-runner:<version>`.

Per [CLAUDE.md](../../CLAUDE.md): a `packages/python-runner/**` change needs a
`feat(pyrunner):` / `fix(pyrunner):` PR title or no `pyrunner-v*` tag is cut and
prod job leases silently rebind to the old image.

## Base image digest-pin policy

The base is pinned by `@sha256:` digest (not just a tag) so rebuilds are
reproducible and a re-tagged upstream image can't change what we ship. To
re-pin after a deliberate base bump:

```bash
docker manifest inspect -v pytorch/pytorch:<new-tag> | jq -r '.Descriptor.digest'
```

then update the `FROM` line in the [Dockerfile](./Dockerfile).

## GPU probe sentinel (exit 89)

[`python-launch.sh`](./python-launch.sh) is an optional entrypoint helper that
runs a cheap `torch.cuda.is_available()` check. If the GPU is not visible it
exits **89** (`GPU_UNAVAILABLE`), which the runner supervisor maps to a clear
"GPU not visible on this provider" error instead of a generic non-zero exit.
boot-job.ts may invoke python directly; the script exists as the sentinel
mechanism and for future use.

## Local build

```bash
cd packages/python-runner
npm run build:image   # docker build -f ./Dockerfile -t akash-fns/python-runner:dev ../..
```

The `../..` context is the repo root, required so the supervisor copy resolves.
