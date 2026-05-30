#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Multi-group GPU validation/diagnostic for "parallel GPU acquisition via a
// single multi-group Akash deployment" (see docs/parallel-gpu-multigroup.md).
// The feature shipped without live bid validation (the Akash GPU market was
// dry) — run this when capacity returns to confirm denom/host/multi-group e2e.
//
// Settled: POST /deployments accepts a 2-group SDL; close works; `uakt` pricing
// is dead (codebase migrated to `uact`); and the `host: akash` placement filter
// is being dropped (it was likely starving bids). So this run is uact-only, no
// host attribute, and answers in one battery:
//
//   1. LANDSCAPE — datacenter-class models an ACTIVE (online+audited) provider
//      with free GPU lists. Picks the most bid-likely from that set.
//   2. PROVIDER SANITY (free POST /bid-screening) — how many providers match a
//      1-GPU spec at all.
//   3. CONTROL — single-group `uact` (prod-faithful shape, no host attr),
//      sweeping the price ceiling [100k → 500k]. Confirms the migrated prod SDL
//      bids and at what ceiling.
//   4. MULTI-GROUP `uact` — only if the control bids. Validates gseq↔SDL order
//      (the real go/no-go); under --accept also leases one group to prove isolation.
//
// Self-contained: Bun or Node 18+ (global fetch), no repo build, no deps. Needs
// only your Console API key. No leases are accepted on the diagnostic probes, so
// only the refundable deposit is ever escrowed; every probe closes in a finally.
//
// ── RUN (from repo root) ──
//   export AKASH_API_KEY=<your Console API key>
//   node packages/server/scripts/spike-multigroup.mjs            # full battery
//   node packages/server/scripts/spike-multigroup.mjs --accept   # also lease one
//                                         # group briefly to verify isolation (4–5)
// Optional: SPIKE_MODELS="a100,h200" (override pick), SPIKE_DEPOSIT=5 (USD),
//           SPIKE_BID_WINDOW_MS=45000, AKASH_API_BASE.
// ─────────────────────────────────────────────────────────────────────────────

const API = (process.env.AKASH_API_BASE || 'https://console-api.akash.network/v1').replace(/\/$/, '');
const KEY = process.env.AKASH_API_KEY;
const DEPOSIT = Number(process.env.SPIKE_DEPOSIT || 5);
const WINDOW = Number(process.env.SPIKE_BID_WINDOW_MS || 45_000);
const ACCEPT = process.argv.includes('--accept');
// Bid-likelihood order for the diagnostic (a100 = reliable workhorse first; the
// priciest/rarest h200 last). Distinct from prod's JOB_GPU_PREFERENCE (capability).
const PREF = ['a100', 'h100', 'l40', 'l4', 'pro6000se', 'h200'];
const AMOUNTS = [100_000, 500_000]; // uact ceiling sweep: prod value, then generous
const isDC = (m) => /^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(String(m).toLowerCase());

if (!KEY) { console.error('✗ export AKASH_API_KEY=<your Console API key> first'); process.exit(2); }

async function call(method, path, { body, flat } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(flat ? body : { data: body }) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(`[${method} ${path}] ${msg}`); err.status = res.status; err.payload = json ?? text; throw err;
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

async function getBids(dseq) {
  let rows;
  try { rows = await call('GET', `/bids?dseq=${dseq}`); }
  catch (e) { if (e.status === 404) rows = await call('GET', `/bids/${dseq}`); else throw e; }
  return (rows || []).map((r) => {
    const b = r.bid ?? r; const id = b.id ?? b.bid_id ?? {};
    const off = (b.resources_offer ?? b.resourcesOffer ?? [])[0]?.resources ?? {};
    const cpuMilli = Number(off.cpu?.units?.val ?? off.cpu?.units ?? NaN);
    return { gseq: Number(id.gseq), oseq: Number(id.oseq), provider: id.provider,
      price: Number(b.price?.amount ?? NaN), cpuCores: Number.isFinite(cpuMilli) ? cpuMilli / 1000 : NaN,
      gpuUnits: Number(off.gpu?.units?.val ?? off.gpu?.units ?? NaN) };
  }).filter((b) => Number.isFinite(b.gseq));
}

async function landscape() {
  const [inv, provs] = await Promise.all([
    call('GET', '/gpu').catch((e) => (console.warn('  ⚠ GET /gpu:', e.message), null)),
    call('GET', '/providers').catch((e) => (console.warn('  ⚠ GET /providers:', e.message), null)),
  ]);
  const providerCount = new Map();
  for (const p of provs || []) {
    if (p.isOnline !== true || p.isAudited !== true) continue;       // isActiveProvider
    if ((p.stats?.gpu?.available ?? 0) <= 0) continue;               // has free GPU
    for (const g of p.gpuModels || []) if (g.model) {
      const k = g.model.toLowerCase(); providerCount.set(k, (providerCount.get(k) || 0) + 1);
    }
  }
  const invFree = new Map();
  for (const m of inv?.gpus?.details?.nvidia || []) if (m.model)
    invFree.set(m.model.toLowerCase(), Math.max(0, (m.allocatable || 0) - (m.allocated || 0)));
  const rows = [...new Set([...providerCount.keys(), ...invFree.keys()])].filter(isDC)
    .map((m) => ({ model: m, providers: providerCount.get(m) || 0, free: invFree.get(m) || 0 }))
    .sort((a, b) => {
      const pa = PREF.indexOf(a.model), pb = PREF.indexOf(b.model);
      if ((pa < 0 ? 99 : pa) !== (pb < 0 ? 99 : pb)) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return b.providers - a.providers;
    });
  console.log('  datacenter-class GPU landscape:');
  for (const r of rows) console.log(`    ${r.model.padEnd(10)} ${r.providers} active provider(s), ${r.free} free units (inventory)`);
  return rows.filter((r) => r.providers > 0);
}

// FREE public preflight: how many providers match a 1-GPU spec at all (no
// attribute filter)? Best-effort — swallow errors, just report a count.
async function bidScreen() {
  const body = {
    name: 'spike-screen',
    requirements: { signedBy: { allOf: [], anyOf: [] }, attributes: [] },
    resources: [{ resources: {
      cpu: { units: { val: '2000' } },
      memory: { quantity: { val: String(4 * 1024 ** 3) } },
      storage: [{ quantity: { val: String(10 * 1024 ** 3) } }],
      gpu: { units: { val: '1' } },
    }, count: 1 }],
  };
  try {
    const r = await call('POST', '/bid-screening', { flat: true, body });
    return (r?.providers ?? (Array.isArray(r) ? r : [])).length;
  } catch (e) { return `error: ${e.message}`; }
}

const GPU = (model) => `        gpu:
          units: 1
          attributes:
            vendor:
              nvidia:
                - model: ${model}`;

// Single group, uact, NO host attribute (dropped — it was starving bids).
function buildSingleSdl(model, amount) {
  return `version: "2.0"
services:
  fn:
    image: nvidia/cuda:12.4.1-base-ubuntu22.04
    command: ["sh","-c","nvidia-smi || echo NO_GPU; echo SPIKE_FN_UP; sleep 3600"]
    expose:
      - port: 80
        as: 80
        to:
          - global: true
profiles:
  compute:
    fn:
      resources:
        cpu:
          units: 2
        memory:
          size: 4Gi
        storage:
          size: 10Gi
${GPU(model)}
  placement:
    dcloud:
      pricing:
        fn:
          denom: uact
          amount: ${amount}
deployment:
  fn:
    dcloud:
      profile: fn
      count: 1
`;
}

// Two groups: group 0 declared FIRST (grp-z, cpu 2, model0), group 1 SECOND
// (grp-a, cpu 4, model1). Anti-alphabetical placement names + distinct cpu let
// us tell declaration-order from alphabetical-order from the bid's resources_offer.
function buildMultiSdl(m0, m1, amount) {
  return `version: "2.0"
services:
  fn:
    image: nvidia/cuda:12.4.1-base-ubuntu22.04
    command: ["sh","-c","nvidia-smi || echo NO_GPU; echo SPIKE_FN_UP; sleep 3600"]
    expose:
      - port: 80
        as: 80
        to:
          - global: true
profiles:
  compute:
    fn-0:
      resources:
        cpu:
          units: 2
        memory:
          size: 4Gi
        storage:
          size: 10Gi
${GPU(m0)}
    fn-1:
      resources:
        cpu:
          units: 4
        memory:
          size: 4Gi
        storage:
          size: 10Gi
${GPU(m1)}
  placement:
    grp-z:
      pricing:
        fn-0:
          denom: uact
          amount: ${amount}
    grp-a:
      pricing:
        fn-1:
          denom: uact
          amount: ${amount}
deployment:
  fn:
    grp-z:
      profile: fn-0
      count: 1
    grp-a:
      profile: fn-1
      count: 1
`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function analyzeGseq(bids, declared) {
  const gseqs = [...new Set(bids.map((b) => b.gseq))].sort((a, b) => a - b);
  const map = gseqs.map((g) => {
    const gb = bids.filter((b) => b.gseq === g);
    const cpu = gb.map((b) => b.cpuCores).find(Number.isFinite);
    const idx = Number.isFinite(cpu) ? (Math.abs(cpu - 2) <= Math.abs(cpu - 4) ? 0 : 1) : NaN;
    return { gseq: g, cpu, idx, model: Number.isFinite(idx) ? declared[idx].model : '?' };
  });
  for (const m of map) console.log(`    gseq=${m.gseq}: cpu≈${m.cpu ?? '?'} ⇒ declared[${m.idx}] = ${m.model}`);
  if (map.some((m) => !Number.isFinite(m.idx))) return { code: 'NO_CPU', map };
  if (gseqs.length < 2) return { code: 'ONE_GROUP', map };
  if (map.every((m, k) => m.idx === k)) return { code: 'DECLARATION', map };
  if (map.every((m, k) => m.idx === map.length - 1 - k)) return { code: 'ALPHABETICAL', map };
  return { code: 'NEITHER', map };
}

let openDseq = null;
async function probe(label, sdl, { declared = null, accept = false } = {}) {
  console.log(`\n▶ ${label}`);
  let dseq, manifest;
  try {
    const c = await call('POST', '/deployments', { body: { sdl, deposit: DEPOSIT } });
    dseq = c.dseq; manifest = c.manifest; openDseq = dseq;
    console.log(`  created dseq=${dseq} (manifest ${String(manifest).length}b); polling ${WINDOW}ms…`);
    const end = Date.now() + WINDOW; let bids = [];
    while (Date.now() < end) {
      bids = await getBids(dseq);
      const gs = [...new Set(bids.map((b) => b.gseq))].sort();
      process.stdout.write(`\r  bids: ${bids.length} gseqs [${gs.join(',')}]    `);
      if (declared ? gs.length >= 2 : bids.length > 0) break;
      await sleep(3000);
    }
    console.log('');
    const out = { dseq, bids, gseqs: [...new Set(bids.map((b) => b.gseq))].sort() };
    if (declared && bids.length) { console.log('  gseq → group:'); out.analysis = analyzeGseq(bids, declared); }
    if (accept && declared && bids.length) {
      const tgt = (out.analysis?.map.find((m) => m.idx === 0) ?? { gseq: out.gseqs[0] }).gseq;
      const w = bids.filter((b) => b.gseq === tgt).sort((a, b) => a.price - b.price)[0];
      console.log(`  [--accept] leasing gseq=${tgt} from ${w.provider}…`);
      await call('POST', '/leases', { flat: true, body: { manifest, leases: [{ dseq: Number(dseq), gseq: w.gseq, oseq: w.oseq, provider: w.provider }] } });
      const aEnd = Date.now() + 5 * 60_000; let leased = [];
      while (Date.now() < aEnd) {
        const d = await call('GET', `/deployments/${dseq}`);
        leased = (d.leases ?? []).map((l) => ({ gseq: Number((l.lease_id ?? l.id ?? {}).gseq), state: l.state, up: Object.values(l.status?.services ?? {}).some((s) => (s.available ?? 0) > 0) }));
        process.stdout.write(`\r  leases: ${leased.map((l) => `g${l.gseq}:${l.state}${l.up ? '✓' : ''}`).join(' ')}    `);
        if (leased.some((l) => l.gseq === tgt && l.up)) break;
        await sleep(5000);
      }
      console.log('');
      out.acceptCheck = { onlyTarget: leased.length === 1 && leased[0].gseq === tgt, up: leased.find((l) => l.gseq === tgt)?.up, leasedGseqs: leased.map((l) => l.gseq) };
      console.log(`  check 4 (only gseq ${tgt} leased): ${out.acceptCheck.onlyTarget ? 'PASS' : 'CHECK'} — leased [${out.acceptCheck.leasedGseqs.join(',')}]`);
      console.log(`  check 5 (workload up): ${out.acceptCheck.up ? 'PASS' : 'INDETERMINATE (cold pull may exceed 5min; check provider logs for SPIKE_FN_UP)'}`);
    }
    return out;
  } finally {
    if (dseq) {
      try { await call('DELETE', `/deployments/${dseq}`); console.log(`  ✓ closed ${dseq}`); openDseq = null; }
      catch (e) { console.error(`  ✗ close FAILED ${dseq}: ${e.message}\n    MANUAL: curl -X DELETE -H "x-api-key: $AKASH_API_KEY" ${API}/deployments/${dseq}`); }
    }
  }
}

process.on('SIGINT', () => { console.log('\n⚠ SIGINT — open deployment:', openDseq ? `curl -X DELETE -H "x-api-key: $AKASH_API_KEY" ${API}/deployments/${openDseq}` : '(none)'); process.exit(130); });

async function main() {
  console.log('▶ uact GPU diagnostic (no host attr) on', API, `| deposit $${DEPOSIT} | window ${WINDOW}ms\n`);
  let biddable = await landscape();
  if (process.env.SPIKE_MODELS) {
    const forced = process.env.SPIKE_MODELS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    biddable = forced.map((m) => ({ model: m, providers: '(forced)', free: '?' }));
    console.log('  SPIKE_MODELS override →', forced.join(', '));
  }
  if (!biddable.length) {
    console.log('\n══ VERDICT: ⚠ CAPACITY — no datacenter-class model has an active provider with free GPU right now. Zero bids expected for ANY GPU SDL. Re-run later or set SPIKE_MODELS.');
    return;
  }
  const m0 = biddable[0].model;
  const m1 = biddable.find((b) => b.model !== m0)?.model;
  console.log(`\n  picked model0=${m0}${m1 ? `, model1=${m1}` : ' — only ONE biddable model; multi-group test needs two (set SPIKE_MODELS)'}`);

  const screened = await bidScreen();
  console.log(`\n  bid-screening (1-GPU spec, no attrs): ${screened} provider(s) match`);

  // CONTROL — single-group uact, sweep the ceiling.
  let control = null, winAmount = null;
  for (const amt of AMOUNTS) {
    const r = await probe(`CONTROL — single-group uact ${m0} @${amt}`, buildSingleSdl(m0, amt));
    if (r.bids.length > 0) { control = r; winAmount = amt; break; }
  }

  if (!control) {
    console.log(`\n══ VERDICT: ⚠ NO BIDS — uact single-group got nothing at any ceiling (${AMOUNTS.join('/')}), no host attr. With ${screened} screened provider(s) for a 1-GPU spec, the lever is capacity/region/provider-config, not denom or attribute. Try SPIKE_MODELS, or check whether ANY deploy bids in your live app. Send me this output + the landscape.`);
    return;
  }

  console.log(`\n  ✓ uact single-group BIDS at amount=${winAmount}. Prod denom/attribute fix looks good.`);
  if (winAmount !== AMOUNTS[0]) {
    console.log(`  ⚠ NOTE: prod amount ${AMOUNTS[0]} got no bids; ${winAmount} did → the uact ceilings in pricingAmount() likely need raising toward ~${winAmount}.`);
  }
  if (!m1) { console.log('\n══ VERDICT: ⚠ PROD FIX CONFIRMED, but only one biddable model — multi-group test needs two (SPIKE_MODELS="a100,h200").'); return; }

  // MULTI-GROUP uact — the real go/no-go.
  const declared = [{ model: m0, cpu: 2, placement: 'grp-z' }, { model: m1, cpu: 4, placement: 'grp-a' }];
  const C = await probe(`MULTI-GROUP — uact ${m0}(cpu2,grp-z) + ${m1}(cpu4,grp-a) @${winAmount}`, buildMultiSdl(m0, m1, winAmount), { declared, accept: ACCEPT });
  if (C.bids.length === 0) {
    console.log('\n══ VERDICT: ❌ MULTI-GROUP NO-GO — single-group uact bids but the 2-group deployment got ZERO bids. Providers are not bidding on the multi-group order shape.');
    console.log('   → Fall back to the N-separate-deployments design (winner-selection logic carries over). Send me this output.');
    return;
  }
  const code = C.analysis?.code;
  console.log(`\n══ VERDICT: ${code === 'DECLARATION' ? '✅ GO — uact single-group bids AND multi-group gseq follows SDL declaration order. Proceed with Phase 1.'
    : code === 'ALPHABETICAL' ? '✅ GO (naming tweak) — multi-group bids; gseq follows ALPHABETICAL placement order. I will name groups g00,g01,… so order matches. Proceed.'
    : code === 'NEITHER' ? '❌ MULTI-GROUP NO-GO — gseq neither declaration nor alphabetical; no stable gseq→GPU mapping. Use N-deployments fallback.'
    : code === 'ONE_GROUP' ? '⚠ INCONCLUSIVE — multi-group bid on only ONE gseq; re-run when both models have providers.'
    : '⚠ INCONCLUSIVE — bids carried no cpu units to map gseq; re-run, or use --accept to read GPU from the leased group.'}`);
}

await main().catch((e) => console.error('\n✗ diagnostic error:', e.message, e.payload ? JSON.stringify(e.payload).slice(0, 400) : ''));
