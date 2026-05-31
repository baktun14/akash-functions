# ADR-0001 — Provider TLS is identity-pinned to the on-chain wallet, not CA-validated

- Status: Accepted
- Date: 2026-05-30
- Scope: the kube-events / logs / status / shell provider-proxy calls (PR3 Tier-2)

## Context

To read a deployment's logs, status, or **kube-events**, you talk to the
**provider directly** — `console-api.akash.network` only mints a short-lived
JWT; it does not proxy the stream. Each provider serves its endpoints over TLS
using a **self-signed certificate**. There is no certificate authority in the
Akash provider model: a provider's identity is its **on-chain wallet address**
(`akash1…`), and that address is carried in the leaf certificate's **subject
CN**. The chain is the root of trust, not a CA.

A standard HTTPS client rejects these certs (`UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
self-signed). Setting `rejectUnauthorized: false` alone would be a real
vulnerability — it would accept *any* cert. The correct, and only, way to verify
a provider's identity is to **pin the leaf cert's CN to the provider's on-chain
wallet address** that we already have from `GET /v1/providers/{address}`.

## Decision

Connect to providers with a custom `https.Agent`:

```ts
new https.Agent({
  rejectUnauthorized: false,          // disables CA-chain validation ONLY…
  checkServerIdentity: (_host, cert) => {
    //  …and this re-adds the verification that actually matters here:
    //  the cert's identity must equal the provider's on-chain wallet address.
    return cert.subject.CN === providerAddress
      ? undefined
      : new Error(`provider cert CN ${cert.subject.CN} != ${providerAddress}`);
  },
});
```

**`rejectUnauthorized: false` here is not "TLS off."** It turns off CA-chain
validation — which is meaningless when there is no CA — and the
`checkServerIdentity` callback re-asserts the check that is meaningful in this
trust model: cryptographic proof that we are talking to the provider whose
on-chain address we resolved. **The manual CN check IS the verification and must
never be dropped.** Removing it (or removing the agent and "fixing the TLS
error" some other way) silently downgrades us to accepting any self-signed cert
— a real MITM hole. Automated security linters flag the `rejectUnauthorized`
literal; this ADR is the standing answer: keep the check, do not "remediate" it.

### Why not add the cert to a trust store

There is nothing to add: the cert is self-signed per-provider and rotates with
the provider's keys; identity is the wallet address, not a CA signature. A trust
store models "a CA vouches for this host" — the wrong model for Akash.

### Why we do the check manually instead of depending on `@akashnetwork/chain-sdk`

`chain-sdk` ships a `CertificateValidator.validateProviderCert(cert, address)`
that does this. We deliberately do **not** take that dependency just for one CN
comparison: it is a large package (chain messages, signing, protobufs) that
would pull a heavy tree into the server and the spike for a one-line check we
can express directly against Node's `tls`/`crypto` peer-cert object. If the
verification ever needs to grow beyond a CN match (SAN handling, address
normalization), revisit this — but the bar to add the dep is "the manual check
became genuinely hard to keep correct," not "a helper exists."

## Consequences

- Tier-2 (`provider-events.ts`) and the `spike-events.mjs` GO/NO-GO spike both
  use this exact agent. Use the `ws` package (not WHATWG `WebSocket`) because a
  custom agent is required.
- The check is load-bearing security, not boilerplate — it carries a comment
  pointing here so a future reader (human or linter) does not strip it.
- Bun is the prod runtime; whether Bun honors a custom `https.Agent` on a `ws`
  socket is the spike's gate. If Bun can't, Tier-2 is deferred (2a + Tier-1 ship
  regardless — they carry no TLS/Bun risk).
