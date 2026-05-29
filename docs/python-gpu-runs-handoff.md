# Handoff — Python GPU Runs, after a grill-with-docs session

**Repo:** `/Users/baktun14/repos/akash-functions` (branch `main`, clean)
**Mode:** planning + grilling only. **No code written, nothing committed.**
**Date:** 2026-05-29

---

## ⚠️ Status: revised plan written, NOT approved

- The **revised, grilled plan** is at
  **`/Users/baktun14/.claude/plans/handoff-written-to-tmp-handoff-python-gp-cuddly-rossum.md`** — read it first.
- It **supersedes** the original `/Users/baktun14/.claude/plans/i-want-to-be-synthetic-tide.md`
  (still useful for the untouched Phase-1 subsystem detail).
- I called `ExitPlanMode`; **the user rejected it** and ran `/handoff`. So the plan is **not approved**.
  When resuming, confirm intent — (a) implement as-is, (b) revise further, (c) break into issues —
  before touching code. Re-run `ExitPlanMode` only after any revisions.
- Predecessor handoff (pre-grill context): `/tmp/handoff-python-gpu-runs.md`.

---

## What this session did

Ran `grill-with-docs` over the original plan. Grounded six challenges against the **actual code**
(via Explore agents) and resolved each with the user through `AskUserQuestion`. The full rationale,
code citations, schema deltas, and updated phases are **in the revised plan** — do not re-derive.
Below is only the decision ledger so you don't reopen settled questions.

### Decisions locked this session (detail in the revised plan's "Decisions resolved in the grill")
1. **D1 — Autonomous teardown via a server-side, encrypted, run-scoped copy of the user's Console key.**
   Code proved the original "three-layer teardown" was mechanically broken: **no Akash key exists
   outside an authed request** (`reconciler.ts:1-4` says so; `closeDeployment` has 3 callers all behind
   `requireAkashKey`; `keyLinks` stores only a hash; runner `process.exit` does NOT close the lease).
   → Cache the user's own key encrypted (reuse `function_variables` encryption), refreshed on every
   authed request, evicted when no active runs; a teardown driver fired by `/complete` + the reconciler
   watchdog uses it. Key **never enters the pod**. Reverses the original "no new platform key"
   constraint (bounded). **ADR candidate.**
2. **D2 — Runner idles after `/complete` (does NOT `exit(0)`)** + boot-time terminal guard.
   Akash = k8s `restartPolicy: Always`, so exit → restart → **re-runs `main.py`**; and exit saves
   **zero** cost (you pay for the open lease, not process activity). User initially picked `exit(0)`
   on a false cost premise, then reversed once corrected.
3. **D3 — `execution_kind` is FUNCTION-level** (store on `functions`, immutable at creation; drop the
   proposed `function_versions.execution_kind`). `FunctionRecord.kind` becomes a stored lookup; keep
   `deployments.run_kind` denormalized for the no-join reconciler.
4. **D4 — Run outcome ≠ lease state.** Teardown sets `state='closed'` within seconds, clobbering any
   `'succeeded'`/`'canceled'` state. → `DeploymentState += 'running'` only; add a dedicated
   `run_outcome` column (`null|succeeded|failed|canceled`), written by `/complete`+cancel, never by
   teardown. **ADR candidate.**
5. **D5 — Cold-start accepted; no warm pool in MVP.** Every run = fresh lease = image pull + pip each
   time; sub-second rerun isn't achievable in MVP. UI shows explicit provisioning phases; skip pip when
   no `requirements.txt`; pin image by digest. Warm pods = Phase 4.
6. **D6 — Function-card semantics for jobs + concurrent runs** (low-stakes, locked): card shows latest
   run's status, no `ingressUrl`, suppress `runnerOutdated`/`runnerStale`; concurrent runs allowed
   (skip the 409 guard on the runs path — DB has no uniqueness constraint, `closeAllActiveDeployments`
   already loops); no multi-run card UI.

### Settled-by-me mechanics (noted in plan, veto if wrong)
- Wallet-key cache refreshed on every authed request; stale-key (rotated) → `closeDeployment` auth-fail
  leaves `teardown_state='requested'`, next authed request's drain retries (old poll-drain survives as
  fallback only).
- Reconciler `reconcileJobRow` now **closes** zombie leases (has the cached key) — upgraded from detect-only.

---

## Verified codebase facts (don't re-investigate)
- **No server-side Akash key** anywhere (env/DB/cache). `closeDeployment` callers: `functions.ts`
  ~L631/L669/L885, all behind `requireAkashKey` (`middleware/auth.ts`). Reconciler is explicitly keyless.
- **`runnerSeenAt` already exists** ([schema.ts:139](packages/server/src/db/schema.ts#L139)) and is
  stamped on every `/current` poll (gated on `?v=<semver>`, `routes/runner.ts:124-135`). Service-mode
  poll loop already honors `404 → exit(0)` (`boot.ts:281-285`). Heartbeat reuse is clean.
- **`POST /health` fatal branch sets `state='failed'`** (`routes/runner.ts:325-330`) — that's why the
  job terminal report MUST be a separate `/complete` endpoint, not `/health`.
- **`function.kind` is not a DB column** — hardcoded `'function'` literal at `functions.ts:99` & `:968`.
- **HMAC runner token is fnId-scoped** (not per-deployment) — `lib/signing.ts`; `/complete` + `/logs`
  can reuse it.
- **No DB uniqueness on `(functionId, state)`**; the 1-active-deployment rule is purely the 409 guard
  at `deploy.ts:65-82`. Singular `FunctionRecord` fields (`status`/`ingressUrl`/`latestDeploymentId`)
  and `latestDeployment()` (createdAt desc limit 1) are the only "one active" assumptions in the UI.

---

## Critical project constraints (unchanged, from CLAUDE.md + user memory)
- **Conventional-commit release gating:** the new `packages/python-runner/**` needs its own
  **`pyrunner-v*`** release train + `feat(pyrunner):`/`fix(pyrunner):` scope, and its publish workflow
  **must also trigger on `packages/runner/boot.ts`** (shared supervisor baked in via build-time `cp`).
  Server/web/runner PR titles must start with `feat/fix/refactor/perf` or no tag is cut and prod
  rebinds to the OLD image.
- **Always branch from `main`** (never edit `main`).
- **Public repo** — keep provider lease URIs / concrete deploy hostnames out of commits/PRs/issues.

---

## Suggested next step
Land **Phase 0** as one atomic PR (migration incl. `functions.execution_kind`, `run_outcome`,
`wallet_console_keys`, `run_logs`; shared types with `DeploymentState += 'running'` only; reserved
vars; every `DeploymentState` switch; reconciler `runKind` branch; frozen contracts; runner-version
bump). The D1 key-cache table and the D4 outcome column are the two grill-driven schema additions —
get them into Phase 0 or you'll churn later.

## Suggested skills for the next session
- **`to-issues`** — break the approved plan into tracer-bullet issues (Phase 0 first, then the four
  Phase-1 seams). Likely the best next move given plan size.
- **`grill-with-docs`** — once out of plan mode, it wanted to write `CONTEXT.md` (none exists; glossary
  seed is in the plan) and two ADRs (D1 key-caching, D4 outcome-vs-state). Offer these.
- **`akash-network:akash`** — authoritative for SDL, Console API close/bids/leases, GPU attributes,
  authz/fee-grant (the Phase-3 alternative to D1's cached key).
- **`superpowers:writing-plans`** — if revising before approval.
- **`superpowers:executing-plans` / `superpowers:subagent-driven-development`** — to execute once approved.
- **`tdd` / `superpowers:test-driven-development`** — backend state machine, `/complete` idempotency,
  `reconcileJobRow` (now closes leases), key-cache round-trip, log dedupe, runner job-mode.
- **`code-review` / `coderabbit:code-review`** — after implementation, before merge.
