#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Tier-2 GO/NO-GO spike for the live kube-events narrative (PR3, deferred).
//
// The Tier-2 feature streams a provider's Kubernetes events for a running job
// (image pull / OOM / BackOff) to the UI. The ONE real unknown is whether a
// cert-pinned `kubeevents` WebSocket works under **Bun** (prod runtime), since
// it needs `ws` + a custom `https.Agent` with identity-pinned TLS — WHATWG
// WebSocket can't take a custom agent. This spike answers, in one run:
//
//   (a) Does the cert-pinned `kubeevents` WS connect under the runtime you run
//       it with? (run it under BOTH `node` and `bun` — that's the gate.)
//   (b) What is `getDeployment`'s lease-status shape for a live python job?
//   (c) Does `kubeevents` replay backlog on connect, or only stream new events?
//
// Tier-2 ships ONLY if this passes under bun. If it fails under bun, defer
// Tier-2 and ship 2a + Tier-1 (which is already done and carries no Bun risk).
//
// Self-contained: needs only your Console API key, a live job's dseq, and the
// `ws` package (`npm i -D ws` in packages/server if missing). NO provider
// hostnames or dseqs are baked into this file — everything is resolved at
// runtime from env, so it's safe to commit (public repo).
//
// ── RUN (from repo root) ──
//   export AKASH_API_KEY=<your Console API key>
//   export SPIKE_DSEQ=<dseq of a CURRENTLY-RUNNING job>   # or pass as argv[2]
//   node packages/server/scripts/spike-events.mjs         # answers (a) under Node
//   bun  packages/server/scripts/spike-events.mjs         # answers (a) under Bun  ← the gate
// Optional: SPIKE_WATCH_MS=20000 (how long to stream), AKASH_API_BASE.
// ─────────────────────────────────────────────────────────────────────────────

import https from 'node:https';
import { X509Certificate } from 'node:crypto';

const API = (process.env.AKASH_API_BASE || 'https://console-api.akash.network/v1').replace(/\/$/, '');
const KEY = process.env.AKASH_API_KEY;
const DSEQ = process.env.SPIKE_DSEQ || process.argv[2];
const WATCH_MS = Number(process.env.SPIKE_WATCH_MS || 20_000);
const RUNTIME = typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';

if (!KEY) { console.error('✗ export AKASH_API_KEY=<your Console API key> first'); process.exit(2); }
if (!DSEQ) { console.error('✗ export SPIKE_DSEQ=<dseq of a running job> (or pass as argv[2])'); process.exit(2); }

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'x-api-key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`[${method} ${path}] ${msg}`);
  }
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
}

// Manual provider-cert identity check — the SAME approach Tier-2 uses, WITHOUT a
// chain-sdk dependency (see ADR-0001). The provider's leaf cert is self-signed;
// its identity is the on-chain wallet address carried in the cert subject CN,
// not a CA chain. This IS the verification — `rejectUnauthorized:false` only
// disables CA-chain validation, which is meaningless here (there is no CA).
function pinnedAgent(providerAddress, report) {
  return new https.Agent({
    rejectUnauthorized: false,
    checkServerIdentity: (_host, cert) => {
      // Node gives a peer-cert object; normalize to a subject CN.
      let cn = cert?.subject?.CN;
      if (!cn && cert?.raw) {
        try { cn = new X509Certificate(cert.raw).subject?.match(/CN=([^\n,]+)/)?.[1]; } catch {}
      }
      report.cn = cn ?? '(none)';
      report.cnMatched = cn === providerAddress;
      if (cn !== providerAddress) {
        return new Error(`provider cert CN ${cn} != on-chain address ${providerAddress}`);
      }
      return undefined; // identity confirmed
    },
  });
}

async function main() {
  console.log(`\n── kube-events spike (runtime: ${RUNTIME}) ──`);

  // (b) Deployment + lease status shape.
  const depl = await call('GET', `/deployments/${DSEQ}`);
  const lease = depl?.leases?.[0];
  if (!lease) throw new Error('no leases on this deployment — is the job actually running?');
  const leaseId = lease.lease_id ?? lease.id ?? {};
  const provider = leaseId.provider;
  const gseq = leaseId.gseq ?? 1;
  const oseq = leaseId.oseq ?? 1;
  console.log(`\n[b] deployment.state = ${depl?.deployment?.state}; lease.state = ${lease.state}`);
  console.log('[b] lease.status shape:', JSON.stringify(lease.status, null, 2)?.slice(0, 800));
  console.log(`    provider=${provider} gseq=${gseq} oseq=${oseq}`);

  // hostUri (authoritative — only from /providers/{address}).
  const prov = await call('GET', `/providers/${provider}`);
  const hostUri = prov?.hostUri;
  if (!hostUri) throw new Error('provider has no hostUri');
  console.log(`    hostUri resolved (kept out of logs by design)`);

  // JWT scoped to events only (narrowest grant).
  const jwtResp = await call('POST', '/create-jwt-token', {
    data: { ttl: 1800, leases: { access: 'scoped', scope: ['events', 'status'] } },
  });
  const jwt = jwtResp?.token;
  if (!jwt) throw new Error('create-jwt-token returned no token (Swagger/Tier-2 endpoint — may have changed)');
  console.log('[jwt] minted, scope=[events,status]');

  // (a) + (c) Open the cert-pinned kubeevents WS.
  const { default: WebSocket } = await import('ws').catch(() => {
    throw new Error("missing dep: run `npm i -D ws` in packages/server, then re-run");
  });
  const report = { cn: undefined, cnMatched: false };
  const host = hostUri.replace(/^https?:\/\//, '');
  const url = `wss://${host}/lease/${DSEQ}/${gseq}/${oseq}/kubeevents`;
  const connectedAt = { t: 0 };
  let firstMsgMs = null;
  let count = 0;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    agent: pinnedAgent(provider, report),
  });

  const started = performance.now();
  await new Promise((resolve) => {
    const done = (why) => { try { ws.close(); } catch {} resolve(why); };
    ws.on('open', () => {
      connectedAt.t = performance.now() - started;
      console.log(`\n[a] ✓ WS OPEN under ${RUNTIME} after ${connectedAt.t.toFixed(0)}ms — cert CN=${report.cn} matched=${report.cnMatched}`);
      console.log(`[c] watching ${WATCH_MS}ms — a burst of events in the first ~1s means it REPLAYS backlog; a trickle means new-only…`);
    });
    ws.on('message', (data) => {
      count += 1;
      if (firstMsgMs === null) firstMsgMs = performance.now() - connectedAt.t - started;
      const s = data.toString().slice(0, 200);
      console.log(`  • event[${count}] +${(performance.now() - started).toFixed(0)}ms ${s}`);
    });
    ws.on('error', (err) => { console.log(`\n[a] ✗ WS ERROR under ${RUNTIME}: ${String(err?.message || err)}`); done('error'); });
    ws.on('close', (code) => { console.log(`\n[a] WS closed (code ${code})`); done('close'); });
    setTimeout(() => done('timeout'), WATCH_MS + 4000);
  });

  console.log('\n── verdict ──');
  console.log(`runtime           : ${RUNTIME}`);
  console.log(`cert CN matched   : ${report.cnMatched} (CN=${report.cn})`);
  console.log(`WS connected      : ${connectedAt.t > 0}`);
  console.log(`events received   : ${count}`);
  console.log(`first event after : ${firstMsgMs == null ? '(none)' : firstMsgMs.toFixed(0) + 'ms'}`);
  console.log(`(c) replay-on-connect: ${count > 1 && firstMsgMs != null && firstMsgMs < 1000 ? 'LIKELY (burst at t≈0)' : 'inconclusive / new-only — confirm against pod age'}`);
  console.log(`\nGATE: Tier-2 is a GO only if "WS connected = true" under \x1b[1mbun\x1b[0m.`);
}

main().catch((err) => { console.error('\n✗ spike failed:', String(err?.message || err)); process.exit(1); });
