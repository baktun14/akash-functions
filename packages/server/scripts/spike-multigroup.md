# Multi-group GPU validation — run procedure

Validates "parallel GPU acquisition via a single multi-group deployment" (see
[../../../docs/parallel-gpu-multigroup.md](../../../docs/parallel-gpu-multigroup.md))
against **real Akash bids**. The feature shipped without live validation because the
GPU market was dry — run this when capacity returns.

Self-contained: Node 18+ / Bun, no repo build, no deps, no backend — needs only your
Console API key. **No leases are accepted on the diagnostic probes** (only the
refundable deposit is ever escrowed; every probe closes in a `finally`). The
`--accept` flag opts into briefly leasing one group on a real GPU.

## What it does (uact-only, no host attribute — matching the shipped SDL)

1. **Landscape** — datacenter-class models an active (online+audited) provider with free GPU lists; picks the most bid-likely.
2. **Provider sanity** — free `POST /bid-screening`: how many providers match a 1-GPU spec at all.
3. **Control** — single-group `uact`, sweeping the ceiling `[100k → 500k]`. Confirms the shipped SDL bids and at what ceiling.
4. **Multi-group `uact`** — only if the control bids. Confirms a 2-group deployment bids and `gseq` follows candidate order; `--accept` leases one group to prove isolation.

## Run (from repo root)

```bash
export AKASH_API_KEY=<your Console API key>
node packages/server/scripts/spike-multigroup.mjs            # full battery
node packages/server/scripts/spike-multigroup.mjs --accept   # also lease one group (checks 4–5)
```
Optional: `SPIKE_MODELS="a100,h200"`, `SPIKE_DEPOSIT=5`, `SPIKE_BID_WINDOW_MS=45000`.

## Verdicts

| Verdict | Meaning | Action |
|---|---|---|
| ✅ **GO** (declaration / alphabetical) | uact single-group bids **and** multi-group `gseq` maps to candidate order | feature confirmed working as shipped |
| ❌ **MULTI-GROUP NO-GO** | single-group bids, 2-group doesn't (or `gseq` unmappable) | switch to the N-deployments fallback (see design doc) |
| ⚠ **NEED TWO MODELS** | single-group uact bids; only one model available | re-run with `SPIKE_MODELS="a100,h200"` |
| ⚠ **NO BIDS** | nothing bids even single-group at 500k | capacity/region/pricing — try other models, or recalibrate `pricingAmount()` uact ceilings |

If the control bids only at `500k` (not `100k`), the script flags that `pricingAmount()`'s uact ceilings likely need raising.

## Watch & auto-run (run the spike the moment capacity returns)

The market is dry today, so rather than poll by hand, leave
[watch-and-spike.mjs](watch-and-spike.mjs) running. It polls Console GPU
inventory (`/gpu` + `/providers`, same landscape pass as the spike) and the
instant **≥2 datacenter-class models** have an active online+audited provider
with free GPU, it fires `spike-multigroup.mjs` **without `--accept`** (refundable
deposits only — no lease accepted) and prints the GO / NO-GO verdict.

```bash
export AKASH_API_KEY=<your Console API key>
node packages/server/scripts/watch-and-spike.mjs            # poll, run spike once, exit
node packages/server/scripts/watch-and-spike.mjs --continue # keep watching after each run
```
Knobs: `SPIKE_WATCH_POLL_MS` (default 300000 = 5m), `SPIKE_WATCH_MIN_MODELS`
(default 2), `SPIKE_WATCH_COOLDOWN_MS` (default 3600000 = 1h, `--continue` only).
Any spike env (`SPIKE_MODELS`, `SPIKE_DEPOSIT`, `SPIKE_BID_WINDOW_MS`) passes
through. Because the trigger set equals the spike's biddable set, a fired run
won't hit the "only one biddable model" inconclusive verdict.
