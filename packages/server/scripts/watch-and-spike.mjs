#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Capacity-watch that auto-runs the multi-group GPU spike when the Akash market
// recovers. The happy path of "parallel GPU acquisition via a single multi-group
// deployment" (docs/parallel-gpu-multigroup.md) shipped without live bid
// validation because the GPU market was dry — this polls Console GPU inventory
// and, the moment ≥2 datacenter-class models have an active (online+audited)
// provider with free GPU, fires spike-multigroup.mjs (NO --accept: refundable
// deposits only, no lease is ever accepted) and prints its GO / NO-GO verdict.
//
// The trigger condition mirrors the spike's own landscape() pass (same /gpu +
// /providers logic, same isDC/PREF), so when this fires the spike will also see
// ≥2 biddable models — avoiding the "only one biddable model" inconclusive run.
//
// Self-contained: Bun or Node 18+ (global fetch), no repo build, no deps. Needs
// only your Console API key.
//
// ── RUN (from repo root) ──
//   export AKASH_API_KEY=<your Console API key>
//   node packages/server/scripts/watch-and-spike.mjs            # poll, run spike once, exit
//   node packages/server/scripts/watch-and-spike.mjs --continue # keep watching after each run
//
// Env knobs:
//   SPIKE_WATCH_POLL_MS     poll interval                 (default 300000 = 5m)
//   SPIKE_WATCH_MIN_MODELS  models needed to trigger       (default 2)
//   SPIKE_WATCH_COOLDOWN_MS cooldown after a run (--continue)(default 3600000 = 1h)
//   AKASH_API_BASE          Console API base
// Anything else (SPIKE_MODELS, SPIKE_DEPOSIT, SPIKE_BID_WINDOW_MS, …) is passed
// through to the spike unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = (process.env.AKASH_API_BASE || 'https://console-api.akash.network/v1').replace(/\/$/, '');
const KEY = process.env.AKASH_API_KEY;
const POLL = Number(process.env.SPIKE_WATCH_POLL_MS || 300_000);
const MIN_MODELS = Number(process.env.SPIKE_WATCH_MIN_MODELS || 2);
const COOLDOWN = Number(process.env.SPIKE_WATCH_COOLDOWN_MS || 3_600_000);
const CONTINUE = process.argv.includes('--continue');
// Same bid-likelihood order + datacenter-class filter as the spike, so the
// trigger set equals the spike's biddable set.
const PREF = ['a100', 'h100', 'l40', 'l4', 'pro6000se', 'h200'];
const isDC = (m) => /^(h100|h200|a100|a40|l40|l4|pro6000|rtx6000|rtx5090)/.test(String(m).toLowerCase());

const SPIKE = fileURLToPath(new URL('./spike-multigroup.mjs', import.meta.url));

if (!KEY) { console.error('✗ export AKASH_API_KEY=<your Console API key> first'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function call(method, path) {
  const res = await fetch(API + path, { method, headers: { 'x-api-key': KEY } });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(`[${method} ${path}] ${msg}`); err.status = res.status; throw err;
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

// Datacenter-class models with ≥1 active (online+audited) provider that has free
// GPU. Mirrors spike-multigroup.mjs landscape(): a model only counts as biddable
// when a live provider actually lists it, not merely when inventory shows units.
async function biddableModels() {
  const [inv, provs] = await Promise.all([
    call('GET', '/gpu').catch((e) => (console.warn(`  ⚠ GET /gpu: ${e.message}`), null)),
    call('GET', '/providers').catch((e) => (console.warn(`  ⚠ GET /providers: ${e.message}`), null)),
  ]);
  const providerCount = new Map();
  for (const p of provs || []) {
    if (p.isOnline !== true || p.isAudited !== true) continue;
    if ((p.stats?.gpu?.available ?? 0) <= 0) continue;
    for (const g of p.gpuModels || []) if (g.model) {
      const k = g.model.toLowerCase(); providerCount.set(k, (providerCount.get(k) || 0) + 1);
    }
  }
  const invFree = new Map();
  for (const m of inv?.gpus?.details?.nvidia || []) if (m.model)
    invFree.set(m.model.toLowerCase(), Math.max(0, (m.allocatable || 0) - (m.allocated || 0)));
  return [...new Set([...providerCount.keys(), ...invFree.keys()])].filter(isDC)
    .map((m) => ({ model: m, providers: providerCount.get(m) || 0, free: invFree.get(m) || 0 }))
    .filter((r) => r.providers > 0)
    .sort((a, b) => {
      const pa = PREF.indexOf(a.model), pb = PREF.indexOf(b.model);
      if ((pa < 0 ? 99 : pa) !== (pb < 0 ? 99 : pb)) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
      return b.providers - a.providers;
    });
}

function runSpike() {
  return new Promise((resolve) => {
    console.log(`\n${ts()} ▶ launching spike (no --accept): node ${SPIKE}\n`);
    // Inherit stdio so the spike's verdict streams straight to this console.
    const child = spawn(process.execPath, [SPIKE], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => { console.log(`\n${ts()} ◀ spike exited (code ${code})`); resolve(code); });
    child.on('error', (e) => { console.error(`${ts()} ✗ failed to launch spike: ${e.message}`); resolve(1); });
  });
}

let stop = false;
process.on('SIGINT', () => { console.log('\n⚠ SIGINT — stopping watch.'); stop = true; process.exit(130); });

async function main() {
  console.log(`▶ capacity-watch on ${API} | poll ${Math.round(POLL / 1000)}s | trigger ≥${MIN_MODELS} biddable model(s)${CONTINUE ? ' | --continue' : ' | one-shot'}`);
  while (!stop) {
    let models;
    try { models = await biddableModels(); }
    catch (e) { console.warn(`${ts()} ⚠ inventory poll failed: ${e.message} — retrying next tick`); await sleep(POLL); continue; }

    const summary = models.length
      ? models.map((m) => `${m.model}(${m.providers}p/${m.free}free)`).join(', ')
      : 'none';
    console.log(`${ts()} ${models.length} biddable model(s): ${summary}`);

    if (models.length >= MIN_MODELS) {
      console.log(`${ts()} ✓ capacity threshold met (≥${MIN_MODELS}).`);
      await runSpike();
      if (!CONTINUE) { console.log(`${ts()} one-shot done — exiting. Re-run with --continue to keep watching.`); return; }
      console.log(`${ts()} cooldown ${Math.round(COOLDOWN / 1000)}s before resuming watch…`);
      await sleep(COOLDOWN);
      continue;
    }
    await sleep(POLL);
  }
}

await main().catch((e) => { console.error(`\n✗ watch error: ${e.message}`); process.exit(1); });
