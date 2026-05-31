# CONTEXT — domain glossary

The load-bearing vocabulary for akash-functions. These terms recur across the
server (`packages/server`), the runner supervisor (`packages/runner`), and the
web app (`packages/web`); pinning them down keeps the code and the ADRs talking
about the same things. Architecture decisions live in [docs/adr/](docs/adr/).

## Run / deployment / lease

- **Run** — one user-facing execution of a function. For a job it is
  run-to-completion; for a service it is the live HTTP workload. Backed by a
  `deployments` row.
- **Deployment** — the `deployments` row *and* the on-chain Akash deployment it
  drives. The row tracks `state` (the lease lifecycle) separately from
  `runOutcome` (what the user's script did) — see **job vs service**.
- **Lease** — the accepted bid binding a deployment to a specific provider
  (dseq/gseq/oseq/provider). Accepting the lease pushes the manifest and
  schedules the pod.
- **dseq** — the on-chain deployment sequence number; the unit of cost and the
  handle every close/teardown call needs.

## Job vs service (`EXECUTION_KIND`)

A function is permanently one product or the other (immutable at creation).

- **Service** — long-lived HTTP workload. The pipeline polls for ingress URIs,
  then marks the deployment `live`.
- **Job** — ephemeral, run-to-completion (Python GPU work). Port-less: the
  pipeline waits for the runner's first heartbeat (not URIs), marks it
  `running`, and the lease is **auto-torn-down** seconds after the script exits.
- **`runOutcome`** (null | succeeded | failed | canceled) is orthogonal to
  `state` (the lease lifecycle) precisely because teardown sets `state='closed'`
  within seconds of a job finishing — the durable result must survive that.

## Wait-for-capacity (delayed start)

- **wait-for-capacity** — opt-in (default ON for GPU runs): on no available
  capacity, park the run in the durable `waiting` state (zero on-chain cost)
  instead of failing, and retry from the reconciler until a lease lands, the
  user cancels, or the wait cap elapses.
- **burst** — one create→bid→lease attempt fired for a waiting row. Each burst
  mints one dseq.
- **no-bid** — the expected "no provider has this spec right now" signal: the
  burst found no bid → close the dseq and stay waiting. *Genuine no-capacity.*
- **boot-failure** — a burst that reached `leased` (got capacity) but whose
  runner never heartbeat (`runnerSeenAt == null`): the container was scheduled
  but never became ready (crash-loop / image-pull failure). Distinct from a
  no-bid — re-bursting it is futile, so it fails fast. See
  [ADR-0002](docs/adr/0002-dseq-audit-log-and-leak-containment.md).

## Leak containment

- **dseq audit log** (`deployment_dseqs`) — append-only record of every dseq the
  app created, with a confirmed-`closedAt`. The safety net the single, nullable
  `deployments.dseq` column cannot be; also the per-run burst counter for the
  runaway cap. See [ADR-0002](docs/adr/0002-dseq-audit-log-and-leak-containment.md).
- **orphan** — an on-chain deployment we created that is still active but whose
  run is terminal, or that is a **superseded** burst (not the deployment's
  current dseq). The orphan sweep closes only these, only on dseqs in the audit
  log (the user's wallet is general, not app-exclusive).

## Observability (planned — PR3)

- **kube-events** vs **run-state** — kube-events are the provider's live
  Kubernetes event narrative for a lease (image pull, OOM, BackOff), surfaced
  for diagnostics; run-state is the app's own lifecycle/outcome. A crash-looping
  job posts no logs, so kube-events are the only failure evidence until the
  reconciler writes the durable verdict.
- **provider hostUri** — the provider's base URL, resolved from its on-chain
  record; where the lease's logs/events endpoints live.
- **JWT scope** — a short-lived provider token minted per use, scoped to the
  operation (e.g. `events`), used to authenticate to the provider proxy.

> TLS to a provider uses self-signed certs pinned to the provider's on-chain
> wallet address (no CA). The rationale and why the manual identity check must
> not be dropped will be recorded in ADR-0001 alongside the kube-events work.
