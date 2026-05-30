# Parallel GPU acquisition via a single multi-group deployment

## What & why

GPU Python jobs used to acquire their lease **sequentially** (`runGpuFallback`): try the
requested GPU, and on no-bid close that deployment and try the next datacenter-class model
one at a time — worst case `GPU_FALLBACK_MAX_ATTEMPTS × GPU_FALLBACK_BID_TIMEOUT_MS ≈ 6 × 20s = 120s`.
A bid on Akash is a provider *reserving* an instance, so probing models in series wastes the
dominant cost (the per-model bid wait).

The **initial launch** now **fans out**: it offers the requested GPU + all available
datacenter-class alternates *at once* as N placement groups of a **single** Akash deployment,
polls bids across all groups, accepts the best one, and lets the unaccepted groups' bids
expire. The additive bid waits collapse into one bounded window
(`GPU_PARALLEL_BID_TIMEOUT_MS ≈ 30s`).

## Glossary

- **Multi-group deployment** — one Akash deployment whose SDL maps the single `fn` service
  under N **placement groups**, each referencing a different GPU compute profile. Each group
  is bid on independently and has its own `gseq`.
- **Group / gseq** — one biddable unit inside a deployment; identifies which candidate GPU a
  bid is for.
- **Fan-out** — the initial-launch act of offering all candidate GPUs at once (as groups),
  then keeping the best bid.
- **Burst** — one create→bid→lease attempt fired by the reconciler for a parked `waiting`
  row (wait-for-capacity). **Retry bursts stay single-group** (the sequential `runGpuFallback`);
  only the **initial launch** fans out, keeping escrow cheap on the patient retry path.

## Decision: ONE multi-group deployment, not N separate deployments

`acceptLeases` takes a `{dseq, gseq, oseq, provider}`, so one deployment can carry N GPU
groups, accept one group's lease, and leave the rest to expire. Choosing **one multi-group
deployment** over **N separate deployments** keeps:

- **one `dseq` per row** → the `functions → deployments` (1→N across runs) relationship is
  unchanged, **no schema migration**, no `gpu_pending_dseqs` array;
- **one `DEPLOY_DEPOSIT` escrow** (not N×) and **one create tx** (no cosmos account-sequence
  conflicts);
- **crash-safety for free** — the existing single-deployment reconciler / teardown / burst
  supervisor sweep the one `dseq` unchanged (no dual-sweeper wiring).

**Contingency:** if multi-group ever proves unworkable end-to-end (see *Deferred validation*),
the fallback is N separate deployments (bounded-concurrency creates + jittered retry, a
`gpu_pending_dseqs text[]` migration, drain in both teardown paths). The winner-selection
logic (`selectGpuWinner`) carries over to either design.

## gseq ↔ candidate mapping (the load-bearing detail) — CONFIRMED

Bids carry a `gseq` and a `resources_offer` with GPU *units* but **no GPU model**, so a bid
can't tell us which GPU it's for directly. The mapping rests on group ordering:

- The chain numbers `gseq` 1..N in **alphabetical order of placement name** — confirmed in
  `@akashnetwork/chain-sdk` `SDL.v3Groups()` (`[...groups.keys()].sort()`), and matching how
  the Akash Console frontend groups bids by `gseq` and accepts one bid's
  `{dseq, gseq, oseq, provider}`.
- `buildSdl` therefore names the groups **`g00, g01, …` in candidate order** (zero-padded so
  string-sort == numeric order). Alphabetical order then equals candidate order, so
  **`gseq i+1 ↔ candidate[i]`** (`groupBidsByCandidate`).

Accepting uses the **bid's own** `gseq/oseq/provider`, so the mapping only decides *which GPU
a group represents* for ranking, never which lease we submit.

## Winner selection (`selectGpuWinner`)

1. **Requested short-circuit** — if the requested GPU's group (candidate 0 / gseq 1) has a
   clean eligible bid, accept it immediately; it can't be outranked.
2. Otherwise the first non-requested eligible bid opens a `GPU_PARALLEL_BID_WINDOW_MS (~6s)`
   collection window; at window end pick the best `JOB_GPU_PREFERENCE` rank, cheapest eligible
   provider within that group.
3. **Accept-failure fall-through** — walk the ranked attempts; on accept error try the next.
4. **Exhaustion** — no clean eligible bid on any group within the timeout → close the one
   `dseq`, then `enterWaitingOrFail` (parks under wait-for-capacity, else fails — same as the
   sequential path). The fan-out never settles for a blocklisted/flaky provider.

## Prod fixes folded into this branch

While validating, we found prod wasn't getting bids at all. Two fixes (unrelated to
multi-group, but prerequisites):

- **Pricing denom `uakt` → `uact`** across the codebase (`sdl.ts`, `deploy/web.sdl.yaml`,
  `deploy/server.sdl.yaml`, README). `uakt` (the chain/gas token) is no longer accepted for
  deployment pricing — `uact` (the deployment-payment token) is required. The amounts
  (`1000` / `10000` / `30000` / `100000`) were carried over and **may need recalibration**
  against live ACT floors.
- **Dropped the `host: akash` placement attribute** from all SDLs (it filtered bidding to
  providers advertising that attribute). Note: bid acceptance (`selectEligibleBid` /
  `pipeline.ts`) only filters **blocklisted** providers, **not** by audit status — so without
  `host: akash` the cheapest *unaudited* provider can win. Add an `isAudited` gate to the bid
  selection if audited-only acceptance is desired.

## Files

- `akash/sdl.ts` — `buildSdl` delegates to the pure, synchronous `buildSdlString(args, image)`;
  `gpuGroups` (2+) emits the multi-group shape, else today's single-group SDL.
- `akash/gpu-inventory.ts` — `buildMultiGroupGpuCandidates` (requested + datacenter alternates,
  preference-ordered, capped); `isDatacenterClassGpu` exported.
- `akash/bid-select.ts` — pure, no-I/O: `selectEligibleBid` (extracted from the pipeline),
  `selectGpuWinner`, `groupBidsByCandidate`, `multiGroupPollOutcome`.
- `akash/pipeline.ts` — single-attempt path now reuses `selectEligibleBid`.
- `routes/runs.ts` — `runGpuMultiGroup` orchestrator; `launchRun` points GPU jobs at it.
  `runGpuFallback` is unchanged and still used by single-candidate launches and reconciler
  retry bursts.
- `env.ts` — `GPU_PARALLEL_BID_TIMEOUT_MS` (30000), `GPU_PARALLEL_BID_WINDOW_MS` (6000).
- **No changes** to `schema.ts`, `reconciler.ts`, `teardown.ts`, `waiting-driver.ts`.

## Verification

- **Unit (TDD):** 47 tests — candidate building, single+multi-group SDL shape, eligibility +
  fallback, winner ranking, gseq mapping, poll-window decision. The orchestrator's pure
  decision logic is fully covered; its I/O wiring mirrors the proven `runGpuFallback`.
- **Deferred — live spike + manual e2e:** blocked by a **market-wide GPU drought** (no GPU on
  any model on Akash right now, confirmed via the Console UI). When capacity returns, run the
  throwaway `spike-multigroup.mjs` to confirm: (a) `uact` (+ no host attr) restores bids and at
  what ceiling; (b) a 2-group deployment bids and `gseq` follows the candidate order; (c)
  accepting one group leases only it and the others draw no escrow. If (b)/(c) fail, fall back
  to the N-deployments design.
