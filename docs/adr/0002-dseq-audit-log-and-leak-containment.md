# ADR-0002 — Append-only dseq audit log + GPU-run deployment-leak containment

- Status: Accepted
- Date: 2026-05-30
- Context: a single GPU run leaked ~48 active on-chain deployments (~$60/hr)

## Problem

A Python GPU **job** (`EXECUTION_KIND=job`) crash-looped on a broken image and,
in doing so, leaked dozens of paid on-chain deployments that nothing tracked or
closed. Three mechanisms combined:

1. **Re-bursting a boot failure.** GPU runs default to wait-for-capacity ON. When
   a burst reached `leased` (a provider gave it capacity) but the container never
   booted, the burst supervisor (`superviseStuckBurst`) reclaimed the row to
   `waiting`, and `driveWaitingRows` re-bursted it on the next tick — minting a
   **new dseq each cycle**. Re-bursting to "find capacity" is futile: the run
   already *had* capacity; the image was broken. There was no hard per-run cap.

2. **Lossy cleanup.** `closeDseqBestEffort` tries twice then swallows the error;
   callers nulled `deployments.dseq` regardless of whether the close succeeded.
   The burst-crash catch re-parked via `enterWaitingOrFail`, which never closed
   the dangling deployment at all.

3. **No safety net.** `deployments.dseq` is a **single column** that gets nulled
   on every reclaim. Once nulled, the prior dseq is unreachable — the reconciler
   is keyless/DB-only, and every teardown/cancel/cross-check path is gated on
   `deployments.dseq`. There was no `listDeployments` and no record of past dseqs.
   Orphans burned until escrow depletion (~4h each).

## Decision

**(1) Don't re-burst a boot-stalled lease.** `superviseStuckBurst` now
discriminates by the stalled burst's state. `state === 'leased' &&
runnerSeenAt == null` means it got capacity but never became ready
(crash-loop / image-pull failure) → **fail fast with a durable verdict and tear
down** (jobs) / fail the row (services), *never* reclaim to `waiting`. Only a
burst still in `pending`/`bidding` (genuine no-capacity) is reclaimed and
retried. This removes the leak's primary generator; the crash-loop now fails at
the first boot-timeout instead of churning for the full wait window.

**(2) Append-only dseq audit log (`deployment_dseqs`).** Every dseq the app
creates is recorded the instant `createDeployment` returns it (before any
bid/lease/close), at all three create sites (the single-attempt pipeline, the
GPU fallback loop, and the GPU multi-group launch). The row is **never nulled**;
`closedAt` is stamped **only after a close is confirmed on-chain**. This is the
durable record the single `deployments.dseq` column cannot be.

**(3) Hard per-run burst cap.** `count(deployment_dseqs WHERE deploymentId=…)` is
the run's lifetime burst count. `driveOne` fails the run once it crosses
`WAIT_FOR_CAPACITY_MAX_BURSTS` (default **25** — a generous runaway backstop, not
a tight bound; the leak hit ~48).

**(4) Shared-wallet-safe orphan sweep.** A sweep closes a logged dseq only when
it is **still active on-chain** *and* is an orphan — either its parent run is
terminal, or it is a **superseded** burst (not the deployment's current dseq).
It verifies each dseq with `getDeployment` before closing, and only ever touches
dseqs in our audit log. It runs in both homes (mirroring teardown): the keyless
reconciler with the cached wallet key, and the authed `GET /api/functions` drain
with a fresh key.

## Why an audit log and not the `deployments.dseq` column

The wallet is the user's **general** Console wallet, not app-exclusive. A sweep
that closed "all active deployments owned by the wallet" could close the user's
unrelated deployments. The audit log is the allowlist: we close **only what we
provably created**. It is also append-only, so a re-burst that nulls
`deployments.dseq` cannot hide a prior dseq from the sweep — the dominant leak.

## Consequences

- A broken-image run now fails fast (one dseq, a clear verdict) instead of
  piling up deployments for hours.
- Any dseq that still leaks (e.g. a close that failed mid-flight) is closed by
  the sweep within a couple of reconciler ticks.
- The sweep uses a grace window (2× the burst-supervisor timeout) so an
  in-flight burst's freshly-created dseq is never mistaken for a superseded
  orphan before `deployments.dseq` catches up.

## Verification

A deliberately-broken-image GPU run fails fast (one dseq, no re-burst), its dseq
is closed and `closedAt`-stamped; a simulated failed close is recovered by the
sweep on the next pass; the sweep never touches a non-app deployment;
`count(deployment_dseqs)` caps the run.
