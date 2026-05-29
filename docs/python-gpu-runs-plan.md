# Python GPU Runs — Modal-style ephemeral jobs on Akash Functions (grilled & revised)

> Supersedes `/Users/baktun14/.claude/plans/i-want-to-be-synthetic-tide.md`. Same goal and
> architecture; this revision incorporates six decisions resolved in a `grill-with-docs` session
> that were grounded against the actual code. The originals's Phase-1 subsystem detail (log batching,
> SSE backfill, CI train, etc.) still applies except where contradicted below.

## Context

A heavy user of both Akash and Modal told us Akash wins on price (~half) but loses the **research
iteration loop**. Modal's value isn't "serverless" — it's a **remote *function* that runs to
completion, streams stdout, then dies**, vs Akash's **remote *machine* you SSH into and babysit**.
The ask: run a Python script on an H100, stream logs, capture the exit code, **auto-teardown** — the
foundation for "run 30 ablations, kill the bad ones, tweak, rerun."

Today every Akash Function is the opposite: a long-lived HTTP service. The runner keeps the child
alive forever and treats exit as a crash ([attachExitWatcher](packages/runner/boot.ts#L994)), pipes
only a 4KB stderr ring (no live stdout), the pipeline marks `live` only when ingress URIs appear and
**never tears down** ([pipeline.ts:117-130](packages/server/src/akash/pipeline.ts#L117-L130)), it's
Bun-only, and `gpu` today just calls external AkashML (no GPU passthrough into user code).

**Goal:** add an ephemeral **"job" execution kind** — submit a Python script → runs on an H100 →
stdout/stderr stream live → exit code captured → **lease torn down automatically**. Reuse the deploy
machinery (bid→lease, GPU SDL block, H100 pricing tier, HMAC code/env fetch, encryption) almost
entirely. MVP = a **single run** end-to-end; `.map()` fan-out, live-sync, and the `akash run` CLI are
later phases (contracts stay forward-compatible). No CLI yet — the web UI is the client, but
REST + SSE + terminal-report contracts are shaped so a thin `akash run script.py --gpu h100` drops in.

---

## Decisions resolved in the grill (the deltas — these change Phase 0 schema, so settle them first)

### D1 — Autonomous teardown via a server-side, encrypted, run-scoped copy of the user's Console key
**Why this changed:** the original "three-layer teardown (runner self-kill + reconciler watchdog +
authed-poll drain)" is mechanically broken. Verified in code: **no Akash key exists anywhere outside
an incoming authed request** — `reconciler.ts:1-4` says so verbatim ("the user's API key is not
available outside an authed request"); `closeDeployment` has exactly 3 callers, all behind
`requireAkashKey`; `keyLinks` stores only `apiKeyHash → walletAddress`, never the raw key; and runner
`process.exit` does **not** close the lease (`attachExitWatcher` keeps the supervisor alive, lease
keeps billing). So "teardown-on-exit" and "silence watchdog" could only *detect/request*, never
*close* — a user who walked away kept paying until they reopened the app.

**Decision:** at run-submit (an authed request that carries the Console key), cache the **user's own**
key **encrypted at rest** (reuse the `function_variables` encryption mechanism), keyed to the wallet,
**refreshed on every authed request**, evicted when that wallet has no active runs. A **teardown
driver** — fired by `POST /complete` and by the reconciler silence/overrun watchdog — uses it to
`closeDeployment` with **no browser open**.
- Resolves the walk-away gap (lease closes seconds after the script exits) **and** the restart-loop
  (lease is gone before the pod can meaningfully restart).
- The key **never enters the pod** (rejected injecting it next to arbitrary user `pip`/Python — a
  malicious wheel would exfiltrate the user's full Akash credential).
- **Fallback:** if `closeDeployment` fails auth (rotated key), leave `teardown_state='requested'`;
  the next authed request's drain retries with the fresh key. The old poll-drain survives only as
  this belt-and-suspenders fallback.
- **This is a deliberate reversal of the original "no new platform key" constraint** — bounded
  (user's own key, encrypted, run-scoped), but it introduces a new storage-of-raw-credentials policy.
  **→ ADR candidate** (threat model: server compromise exposes cached user Console keys).

### D2 — Runner idles after `/complete` (does NOT `exit(0)`); boot-time terminal guard
**Why:** Akash runs workloads as k8s Deployments (`restartPolicy: Always`, not configurable), so an
exited PID 1 **restarts and re-runs `main.py`** — re-executing user side effects (bucket writes,
emails) while still billing. And exit buys **zero** cost saving: you pay for the **open lease**
(reserved GPU), not for process activity — idle and exit bill identically until the lease closes.

**Decision:** after `/complete`, the runner **idles** (keeps PID 1 alive, child gone), keeps
heartbeating `/current` (stamps `runnerSeenAt`, honors `404 → exit(0)` when the lease finally closes).
With D1 the lease closes within seconds; idling avoids even a partial re-run during that window. On
**boot**, `boot-job` checks a new "terminal" flag on `/current` and idles immediately if the run is
already terminal, so a provider-forced restart (node drain/OOM) never re-runs the script.

### D3 — `execution_kind` is a FUNCTION-level property (not per-version)
**Why:** the original put it on `function_versions` ("a version is immutably job or service") but also
routed the **entire UI** on a function-level `FunctionRecord.kind` — which today isn't even a stored
column (hardcoded `'function'` at [functions.ts:99](packages/server/src/routes/functions.ts#L99) /
[:968](packages/server/src/routes/functions.ts#L968)). A function with a `service` v1 and a `job` v2
has no coherent card (RunPanel or ServicePanel? what status pill?). A GPU-job and an HTTP-service are
distinct products.

**Decision:** store `execution_kind` on the **`functions`** table, immutable at creation. Drop the
proposed `function_versions.execution_kind`. `FunctionRecord.kind` becomes a clean stored lookup.
Keep `deployments.runKind` **denormalized** so the reconciler branches with no join.

### D4 — Run outcome is separate from lease state
**Why:** teardown sets `state='closed'` (and `crossCheckAkashStates` does too once the lease leaves
chain) within seconds of `/complete`, **clobbering** any `'succeeded'`/`'canceled'` state value. The
durable success record can't live in `state`.

**Decision:** `DeploymentState += 'running'` **only** (a real lease phase). Add a dedicated
`run_outcome text` column (`null|succeeded|failed|canceled`), written by `/complete` and cancel,
**never touched by teardown**. `exit_code` stays for the "Exit N" display. RunPanel + the function
card compute their pill from `run_outcome` + `exit_code`, not from `state`.

### D5 — Cold-start: accept it, set honest expectations (no warm pool in MVP)
**Why:** every run is a fresh lease → image pull (multi-GB CUDA/PyTorch) + `pip install` **every
run**, no warm reuse until Phase 4. The sub-second "rerun" Modal loop is not achievable in the MVP;
that's inherent to per-run leasing, not a bug.

**Decision:** MVP optimizes for **correctness** of run→stream→teardown, not speed. UI surfaces
explicit provisioning phases ("leasing → pulling image → installing deps → running") so minutes-long
startup reads as progress. **Skip pip entirely when there's no `requirements.txt`** (fast path).
**Pin the image by digest** so providers cache it. Warm pods = Phase 4.

### D6 — Function-card semantics for jobs + concurrent runs (locked, low-stakes)
A job-function's card shows the **latest run's** status (via existing `latestDeployment()`), **no
`ingressUrl`**, and `runnerOutdated`/`runnerStale` suppressed. **Concurrent runs allowed** — the
runs-create path skips the 1-active-deployment 409 guard
([deploy.ts:65-82](packages/server/src/routes/deploy.ts#L65-L82)); the DB has no uniqueness
constraint and `closeAllActiveDeployments` already loops, so nothing breaks. We build **no** multi-run
card UI; the Runs tab is where all runs are listed.

---

## Phase 0 — Shared-contract foundation (land first, one atomic PR)

Freeze contracts + land cross-cutting schema/type changes together so nothing renders `Unknown` and
the reconciler can't HTTP-probe a port-less job to death.

- **Migration** ([schema.ts](packages/server/src/db/schema.ts) + `db/migrations/00XX_python_runs.sql`):
  - `functions.execution_kind text NOT NULL DEFAULT 'service'` **(D3 — source of truth, immutable)**.
  - `deployments`: `run_kind text NOT NULL DEFAULT 'service'` (denormalized), `started_at`,
    `finished_at`, `exit_code integer`, `run_outcome text` **(D4)**, `max_duration_ms integer`,
    `teardown_state text` (`null|requested|closing|done`), `teardown_attempts integer NOT NULL DEFAULT 0`.
  - New **`wallet_console_keys`** table (or equivalent) **(D1)**: `wallet_address text PK`,
    `encrypted_key bytea/text`, `updated_at`, encrypted with the existing secret mechanism. Written on
    every authed request; read only by the teardown driver. Document retention/eviction.
  - New `run_logs` (append-only): `id bigserial PK`, `deployment_id uuid FK ON DELETE CASCADE`,
    `seq integer`, `stream text`, `chunk text`, `shard_index integer NOT NULL DEFAULT 0`, `ts`.
    Index `(deployment_id, seq)`; unique `(deployment_id, shard_index, seq)` for retry dedupe.
  - Extend `function_variables_key_not_reserved` CHECK ([schema.ts:173-176](packages/server/src/db/schema.ts#L173-L176))
    to forbid `EXECUTION_KIND`, `DEPLOYMENT_ID`.
- **Shared types** ([types.ts](packages/shared/src/types.ts)): `DeploymentState += 'running'` **(D4 —
  not succeeded/canceled)**; `FunctionRecord.kind += 'python-job'` (now a stored lookup, D3);
  `FunctionRecord.runOutcome?/exitCode?` for the card; `PresetId += 'python'`; `CreateRunRequest` /
  `CreateAndRunRequest` / `RunRecord`; the `RunLogChunk` union (unchanged from original).
- **Reserved vars** ([reserved-vars.ts](packages/shared/src/reserved-vars.ts)): add `EXECUTION_KIND`,
  `DEPLOYMENT_ID` (keep this list, the SDL emitter, and the DB CHECK in lockstep).
- **Every exhaustive `DeploymentState` switch** in the same PR: `stateToStatus`, `DeploymentsTab.describe`,
  `reconcileRow` — add the `'running'` arm (safe transient label, never failure).
- **Bump `EXPECTED_RUNNER_VERSION`** and gate job SDLs onto a job-capable runner version.

### Frozen contracts
- **SDL env** (in [sdl.ts](packages/server/src/akash/sdl.ts); `buildSdl` gains `executionKind` +
  `deploymentId`): `EXECUTION_KIND=service|job`, `DEPLOYMENT_ID=<uuid>` (row id exists pre-`buildSdl`
  on the runs-create path).
- **Terminal report — ONE endpoint** `POST /api/runner/complete/:fnId` (HMAC). **Do not** overload
  `/health` (its fatal branch sets `state='failed'` — the crash semantics a clean job exit must
  avoid). Payload `{ versionId, exitCode:int(-256..255), phase:'run'|'install'|'no-entry'|'spawn',
  reason?, finishedAt? }`. **Sole writer** of `run_outcome` + `exit_code` + `finished_at` +
  `teardown_state='requested'`; idempotent via `notInArray(state, terminals)`; fires the teardown
  driver **(D1)**.
- **`/current` gains a `terminal` flag (D2)** so a restarted job pod idles instead of re-running.
- **Log ingest** `POST /api/runner/logs/:fnId` (HMAC): batched `{ deploymentId, baseSeq,
  chunks:[{stream,text,ts}] }` — **exit rides `/complete`, never this channel** (logs are lossy;
  the exit signal must be reliable). Flush 16KB/500ms, monotonic `seq`, `onConflictDoNothing`.
- **Client SSE** `GET /api/functions/:id/runs/:runId/logs` (wallet auth, `runId === deploymentId`):
  backfill by `seq` → poll-tail (~750ms) with keepalive → one `end` once terminal **and** caught up;
  `?afterSeq` for reconnect. `RunLogChunk` union mirrors
  [AgentChatChunk](packages/shared/src/types.ts#L110-L114).

---

## Phase 1 — Single run end-to-end (MVP)

### 1. Runner job-mode — `packages/runner/boot-job.ts` (new) + ~4-line dispatcher in [boot.ts](packages/runner/boot.ts)
- Top of boot.ts: `const EXECUTION_KIND = (process.env.EXECUTION_KIND ?? 'service').toLowerCase();`
  Wrap the existing top-level block (≈ [boot.ts:199-245](packages/runner/boot.ts#L199-L245)) in
  `if (EXECUTION_KIND === 'job') await import('./boot-job'); else { <existing, byte-for-byte> }`.
  Export `fetchAndExtract`, `fetchEnvWithRetries`, `sleep`.
- `boot-job.ts`: `prepareJobDir('/app/run')` → parallel(`fetchAndExtract`, `fetchEnvWithRetries`) →
  **terminal-guard check on `/current` (D2)** → `pickPythonEntry` (`main.py` primary; then
  `src/main.py`/`app.py`/`run.py`; `JOB_ENTRY` override = `.map()`/CLI hook) →
  **`pipInstallIfNeeded` — skipped entirely when no `requirements.txt` (D5 fast path)** → heartbeat
  loop (stamps `runnerSeenAt`, honors `404 → exit(0)`, **no** version reload) → `runToCompletion`
  (`python3 -u <entry>`, **no PORT, no --preload**, env-merge minus PORT from
  [spawnChild](packages/runner/boot.ts#L891); both streams piped, tee'd to pod logs + batched sink)
  → await exit → flush logs → `POST /complete` (retries via
  [reportHealthWithRetry](packages/runner/boot.ts#L1153) policy) → **idle until `404` then `exit(0)`
  (D2 — do NOT exit eagerly)**.
- **Exit 0 = success.** No `brokenVersions`, no rollback. Route no-entry / pip-fail / spawn-fail
  through `/complete` (with `phase`), never an uncaught throw. Reuse
  [attachStderrTail](packages/runner/boot.ts#L940)'s reader-loop shape. `preload.ts` unused (Bun-only).

### 2. Python image + CI — `packages/python-runner/` (new package)
- `Dockerfile`: `FROM pytorch/pytorch:2.5.x-cuda12.4-cudnn9-runtime` **pinned by digest (D5)**,
  `COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun`, apt `tar ca-certificates`,
  build-time `cp packages/runner/boot.ts packages/runner/preload.ts packages/python-runner/`
  (byte-identical supervisor, `RUNNER_VERSION` in lockstep), `python-launch.sh`,
  `ENV PIP_CACHE_DIR=/app/.pip-cache PYTHONUNBUFFERED=1`, `CMD ["bun","/boot/boot.ts"]`.
- `pip install -r requirements.txt` at boot into the **system interpreter** (base torch/CUDA live in
  system site-packages); wheel cache on `/app`. Pip failure → `/complete` (`phase:'install'`).
- `python-launch.sh`: cheap `torch.cuda.is_available()` probe → **exit 89 = `GPU_UNAVAILABLE`**
  sentinel (runner maps to a clear "GPU not visible on this provider" error) → `exec python3 -u "$@"`.
- **SDL selection** ([runner-image.ts](packages/server/src/akash/runner-image.ts)): add
  `resolvePythonRunnerImage()` (env `PYTHON_RUNNER_IMAGE`, tag prefix `pyrunner-v`, own stale cache);
  refactor shared lookup into `resolveImage(spec, tagPrefix, cacheSlot)`. `buildSdl` picks it when
  `executionKind==='job'`. GPU block + H100 pricing tier ([sdl.ts:67](packages/server/src/akash/sdl.ts#L67))
  reused as-is. Keep `expose:3000→80` in the SDL (outbound callbacks unaffected; we just never read
  `services.fn.uris`).
- **CI**: new `.github/workflows/pyrunner-publish.yml` mirroring
  [runner-publish.yml](.github/workflows/runner-publish.yml) on a `pyrunner-v*` train — **must also
  trigger on `packages/runner/boot.ts` changes** or it ships a stale supervisor. amd64-only.
  `server-publish.yml` gains a parallel `PROD_PYTHON_RUNNER_IMAGE` resolve + rebind. Add
  `feat(pyrunner):`/`fix(pyrunner):` to the [CLAUDE.md](CLAUDE.md) table; extend
  [sync-versions.mjs](packages/releaser/sync-versions.mjs). **(Per CLAUDE.md: a
  `packages/python-runner/**` change MUST cut a `pyrunner-v*` tag or job leases rebind to the old image.)**
- Bump job-kind default `resources.storage` well above the CPU baseline (pip + CUDA wheels = no ENOSPC).

### 3. Lease lifecycle + teardown — [pipeline.ts](packages/server/src/akash/pipeline.ts), [reconciler.ts](packages/server/src/akash/reconciler.ts), `akash/teardown.ts` (new), `akash/key-cache.ts` (new, D1)
- **Pipeline**: `StartDeployArgs` gains `runKind` + `maxDurationMs`. Steps 1-3 unchanged. Branch step
  4 for jobs: **no URI poll** — poll until `isRunnerFresh(runnerSeenAt)`, then
  `setState('running', { startedAt: now })`.
- **Key cache (D1)** `akash/key-cache.ts`: `cacheWalletKey(wallet, akashKey)` (encrypt + upsert,
  called from every authed request / at least the runs-create + `GET /api/functions` paths),
  `getWalletKey(wallet)` (decrypt), eviction when no active runs.
- **Terminal endpoint** `POST /api/runner/complete/:fnId` ([runner.ts](packages/server/src/routes/runner.ts)):
  idempotently set `run_outcome` + `exit_code` + `finished_at` + `teardown_state='requested'`, then
  fire `requestTeardown`. Also stamp `runnerSeenAt` in `POST /health` (one-line add).
- **Teardown** (`akash/teardown.ts`): `requestTeardown(id)` + `runTeardown(id)` — **reads the key from
  the cache (D1)**, CAS-claim via `teardown_state`, call
  [closeDeployment](packages/server/src/akash/console-client.ts), set `closed`+`closedAt`+`done`,
  capped retry via `teardown_attempts`. Generalize `closeAllActiveDeployments(fnId, akashKey,
  { terminalState })` so cancel + teardown share one close. `drainPendingTeardowns()` still runs on
  `GET /api/functions` as the **fallback** (stale-key recovery).
- **Reconciler watchdog**: `if (row.runKind==='job') return reconcileJobRow(row)` at the top of
  `reconcileRow` (jobs stay in the candidate set but **must not** hit the HTTP reachability probe).
  `reconcileJobRow` handles overrun (> `maxDurationMs`), **runner-silence** (stale `runnerSeenAt` on a
  `running` job), and orphan sweep (terminal-but-not-`closed`) — and **now actually closes the lease
  using the cached key (D1)**, upgrading it from detect-only. Pre-heartbeat jobs get a long boot grace.
- **Cancel** `POST /api/functions/:id/runs/:runId/cancel` (authed) → close lease + `run_outcome='canceled'`.
- **Timeouts** ([env.ts](packages/server/src/env.ts)) — `JOB_BOOT_TIMEOUT_MS≈15min`,
  `JOB_RUNNER_SILENCE_MS≈90s`, `JOB_TEARDOWN_MAX_ATTEMPTS≈8`, and a **generous, user-overridable**
  `JOB_MAX_DURATION_MS` (default e.g. 6h, snapshotted onto the row) — runaway backstop (now genuinely
  enforceable since the reconciler has the key), not a cost cap.

### 4. Log streaming — [runner.ts](packages/server/src/routes/runner.ts), [functions.ts](packages/server/src/routes/functions.ts), boot-job.ts
- Runner: two-stream tee + batched flusher → `POST /api/runner/logs/:fnId` (gated on job-kind; service
  keeps `stdout:'inherit'`).
- Backend: insert chunks (dedupe), per-run total cap with a truncation sentinel; `run_logs` persists
  past teardown so finished runs replay.
- SSE consumer at `/runs/:runId/logs` reusing the [agentChatStream](packages/server/src/routes/agent.ts)
  `streamSSE` pattern; DB poll-tail for MVP (LISTEN/NOTIFY later behind the same contract).

### 5. API + Web UI — [functions.ts](packages/server/src/routes/functions.ts) / [deploy.ts](packages/server/src/routes/deploy.ts), [api.ts](packages/web/src/lib/api.ts), new `run-panel/`
- **REST**: `POST /:id/runs`, `POST /runs` (create-and-run: function + version + first run +
  `cacheWalletKey` in one txn), `GET /:id/runs/:runId`, `GET /:id/runs`, `POST /:id/runs/:runId/cancel`,
  + the SSE logs route. **Runs-create skips the 409 guard** (D6 — concurrent runs allowed).
- **ApiClient** ([api.ts](packages/web/src/lib/api.ts)): `createRun`/`createAndRun`/`getRun`/`listRuns`/
  `cancelRun`/`streamRunLogs` (last mirrors [agentChatStream](packages/web/src/lib/api.ts#L914-L961)) —
  in both `LiveApi` and `MockApi`.
- **Builder**: `'python'` preset card in [presets.ts](packages/web/src/data/presets.ts) +
  [FunctionBuilder.tsx](packages/web/src/components/builder/FunctionBuilder.tsx) editing a
  `{ main.py, requirements.txt }` source map, reusing `GpuSelect` for H100; primary button **"Run"** →
  `createAndRun`. Function is created `execution_kind='job'` (D3, immutable).
- **RunPanel** (new `packages/web/src/components/run-panel/`): mounted instead of `ServicePanel` when
  `kind==='python-job'`. Status pill from **`run_outcome` + `exit_code` (D4)** (`running` /
  `succeeded Exit 0` / `failed Exit N` / `canceled`), **explicit provisioning phases (D5)**, run-summary
  row (GPU / provider / live duration / exit code / client-side cost estimate), live `LogConsole` fed
  by `streamRunLogs` (stderr tinted, `?afterSeq` reconnect), reduced tabs (Logs / Source / Runs / Settings).
  Dashboard routes `python-job` cards here; cards show latest-run status, no ingress URL (D6).

---

## Glossary (to seed CONTEXT.md once out of plan mode — none exists yet)
- **Function** — a user-owned unit of code; now permanently either a **service-function** or a
  **job-function** (`functions.execution_kind`, immutable). Distinct products with distinct UIs.
- **Version** — an immutable snapshot of a function's source; inherits its function's execution kind.
- **Run** — one execution of a job-function = exactly **one `deployments` row** (no `runs` table).
- **Lease state** — Akash infra lifecycle of a run's deployment (`pending…running…closed`/`failed`).
- **Run outcome** — what the user's script did (`succeeded`/`failed`/`canceled`); **orthogonal** to
  lease state and survives the lease close.
- **Teardown** — closing the Akash lease; driven server-side by the cached wallet key, not the browser.

## ADR candidates (offer to write `docs/adr/` once out of plan mode)
1. **Cache the user's Console key server-side (encrypted, run-scoped) to enable autonomous teardown.**
   Hard to reverse (storage/security policy), surprising (today only a hash is stored), real trade-off
   (vs poll-drain / pod-injected key / authz-grant). **D1.**
2. **A run is one `deployments` row; run outcome is modeled separately from lease state.** **D4** +
   the no-`runs`-table architecture.

## Top risks (updated)
- **Lost terminal report** — `/complete` idempotent + acked before runner idles; silence watchdog now
  closes zombie leases autonomously (has the key); `crossCheckAkashStates` reconciles on-chain.
- **Stale cached key** — `closeDeployment` auth-fail leaves `teardown_state='requested'`; next authed
  request retries with a refreshed key (poll-drain fallback).
- **Cold start vs timeouts** — `running` keys off first heartbeat (before pip); `JOB_BOOT_TIMEOUT_MS`
  separate from max-duration; digest-pinned image; no-`requirements.txt` fast path.
- **Log loss/order** — `python3 -u` + `PYTHONUNBUFFERED=1`; byte/time flush (not only `\n`, for
  `tqdm \r`); monotonic `seq` + unique-index dedupe; `?afterSeq` resume; exit rides `/complete`.
- **`RUNNER_TOKEN` in-process with user code** — same trust boundary as today's HTTP functions; token
  is fnId-scoped (low blast radius). The cached **Console** key is the bigger asset and is kept
  **out** of the pod by design (D1).
- **State-machine fan-out** — migration + reconciler `runKind` branch + every `DeploymentState`
  switch land in one atomic PR (Phase 0); a missed reconciler arm HTTP-probes a port-less job to death.

## Later phases (forward-compatible)
- **Phase 2 — `.map()` fan-out**: nullable `run_group_id` + `run_logs.run_id` (additive); one logical
  run = N deployment rows; `shardIndex` already carries the shape; per-shard teardown reuses `teardown.ts`.
- **Phase 3 — live-sync + `akash run` CLI** + Akash authz/fee-grant scoped to `MsgCloseDeployment`
  (lets us retire the cached-key approach for an even tighter security posture) + streaming pip output.
- **Phase 4 — warm pods / dep persistence** (the real fast rerun loop), custom base images,
  JAX/TF bases, LISTEN/NOTIFY tail, server-computed cost.

---

## Verification (end-to-end)
1. **Image smoke test (local):** build `packages/python-runner`, run `EXECUTION_KIND=job` against a
   local stub serving `/api/runner/code|env|current` for a `main.py` that prints + a tiny `torch`
   matmul; confirm pip install (and the no-`requirements.txt` fast path), `torch.cuda.is_available()`
   path + the exit-89 sentinel on a non-GPU box, live log POSTs, a `/complete` with `exitCode:0`, and
   that the runner **idles rather than exits** after `/complete`.
2. **Backend unit/integration:** migration applies; `buildSdl({executionKind:'job'})` emits
   `EXECUTION_KIND`/`DEPLOYMENT_ID` + the python image; `/complete` sets `run_outcome`+`exit_code`,
   fires teardown, is idempotent (re-POST = no-op); `reconcileJobRow` force-terminates an overrun/silent
   job **and closes the lease via the cached key**; `cacheWalletKey`/`getWalletKey` round-trips
   encrypted; concurrent runs of one function are allowed; an existing service function's path is
   byte-for-byte unchanged.
3. **Live H100 run (the real test):** from the web UI, create a `python` function (`main.py` printing
   GPU info + a short loop, a `requirements.txt`), Run on `nvidia h100`; observe bid→lease→`running` on
   heartbeat, **live logs streaming**, `succeeded Exit 0`, and the lease **auto-closed within seconds
   with no further interaction** (verify on-chain/Console — this is the D1 proof). Then `sys.exit(3)`
   → `failed Exit 3`, lease closed. Then **close the browser mid-run** and confirm the lease still tears
   down on completion (D1). Then **Cancel** mid-run → `canceled`, lease closed.
4. **Provider compatibility:** validate the pinned CUDA/torch digest against H100 providers that
   actually bid (`torch.cuda.is_available()` catches driver-floor mismatches) **before** locking the tag.
5. **Regression:** deploy an existing `rest`/`jsx` service — service mode unchanged, reconciler still
   probes ingress, hot-reload still works.
