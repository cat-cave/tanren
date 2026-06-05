# Future-refactor & scale north-star (10 → 1M, zero-trust)

**Status: analysis / scoping. No build is authorized by this doc.** A Rust rewrite is **HELD**.
(Update: the RLS + control/data-plane split this doc once called "plan-only" has shipped — RLS
fully enforced + live-validated, the plane split complete through Vault per-run scoped credentials,
and `LISTEN/NOTIFY` replaced the 1s polling. The remaining prepwork below — the data-access seam,
the DB-row JSON-Schema export, conformance for the un-seamed surfaces — is the live to-do.) This is
the _map_ of the binding constraints in the **real current architecture** and the highest-leverage
moves that make the eventual refactor feasible. Decisions are deferred.

It builds on, and does **not** duplicate:

- [`portability-and-longevity.md`](./portability-and-longevity.md) — the existing
  north star (contracts-as-durable-asset, JSON-Schema export, conformance suites,
  mutation testing, harness protocol, the OSS↔hosting billing seam). Read it first.
- [`ROADMAP.md`](../../ROADMAP.md) — the SaaS hardening history (RLS denies-by-default,
  control/data-plane split, Vault per-run scoped credentials, `42501`-proven). This doc tells you
  _what scale forces_ the plane split to become; the roadmap records that work as done.
- [`PROJECT_BRIEF.md`](../../PROJECT_BRIEF.md) — the durable vision and the eight
  architectural invariants (§1.2), which constrain every option below.

The governing principle is unchanged from the longevity doc: **make the contracts
the durable asset and the implementation disposable.** Everything here is in
service of keeping that true as the system grows three to six orders of magnitude.

---

## 0. Where the real system is today (grounding)

Read before trusting any claim below. The shape, as actually built on `main`:

- **One process, one pool.** `services/orchestrator` is a single Node service that
  opens **one** `pg.Pool` (`db/src/client.ts`: `new Pool({ connectionString })`,
  constructed once in `main.ts`). Every repository, route loader, SSE stream, and
  the worker share it.
- **The worker is in-process and event-driven.** `engine/worker/runWorker.ts` runs
  _inside_ the HTTP server, gated behind `TANREN_RUN_WORKER=1` (default OFF). Slots
  loop claim→execute→idle. There is no separate worker fleet, no external queue.
- **The queue is Postgres-native and already correct in shape.**
  `engine/contracts/jobQueue.ts` `claim()` is the textbook
  `… FOR UPDATE SKIP LOCKED LIMIT 1` CTE + CAS to `running` with a lease
  (`leased_until`, `heartbeat_at`), reaped by `engine/worker/jobReaper.ts`.
  **`LISTEN/NOTIFY` is wired** (`db/src/notify.ts`, channel `tanren_run`): every
  run-state write fires a `NOTIFY` at commit, and the worker + SSE stream wake on it
  rather than polling. A long backstop interval bounds latency only if a NOTIFY is missed — the 1s hot poll is gone.
- **Data access is raw SQL, hand-typed, scattered.** The orchestrator does **not**
  use Drizzle as its query layer — Drizzle lives in `db/` for the schema +
  migrations only. Routes and the engine issue **~207 raw `pool.query(...)` call
  sites across ~53 files**, plus ~63 files carrying inline `SELECT/INSERT/UPDATE`
  SQL string literals (~269 query-bearing sites total). Each result row is
  re-typed by hand (a `RawRunRow` interface + a Zod `RunRow` validator per table,
  e.g. `engine/repositories/runs.ts`). The `engine/repositories/**` directory
  (actors/jobs/runs/specs/tasks, ~567 lines) is a _partial_ data-access layer: the
  canonical write paths go through it, but most **read** paths (route loaders, SSE,
  DORA, costs, insights) issue their own SQL directly against the shared pool.
- **Tenant isolation is Postgres-RLS-enforced.** `org_id` is `NOT NULL` on the core
  tables and **RLS policies deny by default** keyed on a session-set org (see
  `db/src/orgScope.ts`): a query off the org-scoped client sees zero cross-tenant
  rows even if a hand-written `WHERE org_id = $n` is forgotten. Loaders still carry
  the predicate as defense-in-depth, but the database — not the application — is now
  the isolation backstop. (The collapsed baseline `0000_collapsed_baseline.sql`
  carries the `NOT NULL` constraints and the RLS policies; the old per-migration
  numbers are gone.)
- **The dashboard is a BFF that re-derives types over HTTP.**
  `services/dashboard` (Hono SSR + esbuild-built client "islands" under
  `src/client/**`) does **not** read Postgres for product data; it `fetch()`es the
  orchestrator (`ORCHESTRATOR_URL`, default `http://localhost:3100`) through typed
  clients in `src/api/*Client.ts`. The response shapes are **hand-mirrored** in
  `src/api/*Types.ts` ("the dashboard-side mirror of the orchestrator's …
  contracts"), not generated and not drift-checked against the orchestrator's
  Zod/JSON-Schema source — the single largest type-sharing gap in the system.
  `api/types.ts` sits **exactly at the 500-line cap**.
- **Contracts already exist as a neutral artifact.** Zod is the authoring tool;
  `contracts/json/**` is the exported JSON-Schema (events/state/answerers/http/
  insights), regenerated by `scripts/contract-schema-export.mjs` and pinned by the
  `check:contract-schema-drift` gate. DB row shapes are **not** in that export
  (they live as Drizzle tables, neutral via SQL migrations + the schema-drift
  gate).
- **Four seams have conformance suites.**
  `services/orchestrator/tests/conformance/**` covers `Allocator`, `JobQueue`,
  `EventStore`, `SecretStore` — each a shared suite any impl (fake / real / future
  Rust) must pass. Stryker mutation testing is wired (`just mutation`, ~40% scope
  floor). Adapter seams beyond those four (`SshSubstrate`, `CostResolver`,
  `NotificationOutbox`, provider/harness adapters, `GitHubHttpClient`) have
  contracts but **no conformance suite yet**.
- **The 500-line cap is real and biting.** `scripts/check-architecture.mjs` fails
  any source file over 500 lines (`file-line-max-500`). Multiple files now sit
  _at_ 500 (`routes/runs/list.ts`, `dashboard/src/api/types.ts`) or within a
  handful (`reviewMerge/mergeDispatch.ts` 498, `providers/github.ts` 497,
  `routes/forge/index.ts` 496). The cap is doing its job — surfacing modules that
  have outgrown their boundary — but several are now structurally stuck.

---

## 1. Code structuring — the ideal module/package shape

### Where the current structure strains

1. **No real data-access layer (the biggest structural debt).** ~269 query-bearing
   sites, raw SQL, per-call hand-typed rows, the `org_id` predicate copy-pasted
   into every read. `engine/repositories/**` is the right idea applied to ~5
   tables on the write path only. The strain: **correctness** — isolation is a
   hand-written `WHERE` per site, one omission is a cross-org leak (RLS is the fix,
   §3/§5); **refactor cliff** — a schema change ripples to N call sites not one
   method, and a Rust port re-derives 269 SQL strings instead of a bounded set of
   repository contracts; **test surface** — there is no single seam a Rust
   repository impl could slot behind and run against a conformance suite (unlike
   `JobQueue`/`EventStore`, which _do_ have that).
2. **500-line-cap pressure points** are the structural smell, not the problem.
   Files pinned at 500 (`routes/runs/list.ts`, `dashboard/api/types.ts`,
   `mergeDispatch.ts`, `providers/github.ts`, `routes/forge/index.ts`) are modules
   doing two jobs: e.g. `list.ts` is _both_ the read-API query layer _and_ the
   row-mapping layer; `api/types.ts` is the dashboard's entire re-derived contract
   surface in one file. The cap is a forcing function pointing exactly at the
   consolidation work.
3. **Provider adapters duplicate endpoint/credential/cost wiring.** `providers/
{claude,codex,opencode,aider}.ts` (~419–497 lines each) repeat base-URL
   override, credential materialization, and token-usage parsing. The harness
   protocol (longevity doc §4) is the consolidation target.

### The ideal shape (a target, not a sprint)

Keep the **multi-service / multi-seam** boundary that already exists
(orchestrator / dashboard / db over HTTP+SQL+SSH+events) — it is the asset. Refine
_within_ it:

- **A single data-access layer (`engine/data/**`), one method per query intent,
one row-mapper per table.** Collapse the ~269 raw sites behind it. Every method
takes an `ActorContext`(or an org-scoped handle) so the`org*id` predicate is
  applied \_structurally*, never by the caller. This is the seam a Rust repositories
  crate slots behind, and the seam RLS makes belt-and-suspenders rather than
  load-bearing. **The highest-leverage early move** (see §7).
- **Promote it to a conformance-covered seam** like `JobQueue`/`EventStore` already
  are: a `Repositories` contract + a shared conformance suite + an in-memory fake.
  Today only the write-path repositories approximate this, none with a suite.
- **One neutral contract package the dashboard consumes** (kill the hand-mirrored
  `api/*Types.ts`): generate the dashboard's client types from the same JSON-Schema
  export the orchestrator emits (§2). The 500-line `api/types.ts` stops being a
  hand-maintained liability.
- **Crate-shaped module boundaries now, in TS.** Structure the engine as if each
  major seam were already a separate publishable unit (`contracts`, `data`,
  `queue`, `substrate`, `providers`, `workflow`, `costs`). The TS module
  graph is the dry-run of the eventual Rust workspace crate graph — a clean
  boundary today is a `Cargo.toml` member later; a leaky one is a rewrite.

The test: **could you replace one engine module with a Rust binary, behind its
contract, and prove it green against the same conformance + behavior tests?** True
today for `JobQueue`/`EventStore`/`Allocator`/`SecretStore`; making it true for
**data access** and **the substrate** is the structuring north star.

---

## 2. Type generation & sharing backend ↔ frontend

### Today

- **Authoring:** Zod, in the orchestrator. **Neutral artifact:** `contracts/json/**`
  JSON-Schema, draft-2020-12, drift-gated. **Rust path:** documented as
  `contracts/json/**` → `typify` → `serde` (longevity doc §3). All good and
  already shipped for events/state/answerers/http/insights.
- **The gap:** the **dashboard re-derives types by hand** (`api/*Types.ts`). It
  is a third hand-maintained copy of the contract (Zod → JSON-Schema → _hand-typed
  TS mirror_), with **no drift gate** between the orchestrator's HTTP contract and
  the dashboard's mirror. DB row shapes are also outside the JSON-Schema export
  (neutral only via Drizzle migrations + the SQL drift gate — fine for the SQL
  port, not consumable as shared TS/serde types).

### The single-source-of-truth target

Make **JSON Schema the one neutral source**; make _every other representation a
generated artifact drift-gated back to it_:

```
        Zod (authoring, orchestrator)                Drizzle tables (db/)
                    │                                        │
                    ▼                                        ▼
        contracts/json/**  ◄── (add DB row schemas) ── SQL migrations
          (neutral SoT, draft-2020-12)                 (already neutral)
            │              │                │
            ▼              ▼                ▼
   TS client types   serde Rust types   (future) other FE
   (dashboard, gen)  (future backend)
            │
            ▼
   drift gate: generated == committed   (same mechanism as
                                         check:contract-schema-drift)
```

Concretely, the pipeline extends the **already-shipped** export machinery
(`scripts/contract-schema-export.mjs` + the `catalog.ts` enumerator + the
`--check` drift gate), so this is _extension, not invention_:

1. **Add DB row contracts to the export.** Today `events/state/answerers/http/
insights` are exported; DB rows are not. Promote the per-table Zod row
   validators (the `RunRow`-style schemas in `engine/repositories/**`) into the
   catalog so row shapes become first-class neutral contracts — also a prerequisite
   for the data-access seam in §1.
2. **Generate the dashboard's client types** from `contracts/json/http/**` instead
   of hand-mirroring them, + a drift gate (`api/*Types.ts` → regenerated
   `api/*.gen.ts`; the gate fails if the committed file diverges). Kills the
   largest type-sharing gap and unsticks the 500-line `api/types.ts`.
3. **Pin the Rust serde generation in CI _before_ a Rust line is written** (§6):
   run `typify` over `contracts/json/**` in a check job that fails if generation
   errors. This proves the neutral schema is _continuously Rust-portable_, so when
   the rewrite starts the types are already known-good — not a discovery during the
   port.

End state: a Rust backend (serde) and the TS frontend (and any future frontend)
**share one neutral schema source**; drift is a CI failure in every direction;
nobody hand-maintains a type mirror. **Known carve-out** (from the longevity doc):
the harness-protocol I/O shapes (`WriterResult`, `TokenUsage`,
`AnswererRunOptions`) are TS `interface`s, not Zod — prose-documented, not
auto-exported; promoting them to Zod closes the last hand-typed contract boundary.

---

## 3. Architecture restructuring — is the monolith the right shape?

**For now: yes, keep the monolith-with-flagged-worker.** It honors PROJECT*BRIEF
§1.2 (one DB, one process model, no host code), the queue is already correct in
shape, and a single deployable is right while the binding constraint is \_workflow
correctness*, not throughput. The flag (`TANREN_RUN_WORKER=1`) is already the seam:
the worker is a separable concern wearing a process boundary it hasn't put on yet.

**The first real split is forced by scale, not aesthetics, and it is the one the
RLS + plane-split plan already anticipates.** Don't pre-split; let the bottleneck
analysis (§4) trigger each step. The planes that want to become first-class, in
the order scale forces them:

- **Data plane (worker fleet) first.** The worker is already claim-loop-isolated;
  only the flag + shared pool keep it in-process. Promoting it to a horizontal
  fleet (N processes running the same `runSlot` against the same `FOR UPDATE SKIP
LOCKED` queue) is the lowest-friction split — the queue contract was built for
  exactly this, and the SSH substrate already makes the _execution_ remote.
- **Control plane (HTTP API + dashboard BFF) second.** Stateless handlers scale
  horizontally trivially once they stop sharing a process with the worker. The
  `internalRpc.ts` contract (`createRun`/`getRun`) is the already-defined seam
  between "accept work" (control) and "execute work" (data) — in-process today,
  designed to become a network call.
- **Edge plane (SSE/event fan-out) third**, when connection count is the constraint.

**Tie-in, not duplication:** the **RLS direction is what makes the plane split
safe.** A worker fleet + a control-plane API touching one Postgres is only
tenant-safe if isolation is enforced _in the database_ (RLS keyed on a session-set
`org_id`), not in hand-written `WHERE` clauses spread across parallel processes.
**RLS landed first (enforced today), so the worker fleet is now a safe split** —
the shipped policies (`db/src/orgScope.ts` + the collapsed baseline) own the
session-variable / role mechanics.

---

## 4. Scale path: 10 → 100 → 1,000 → 1,000,000 concurrent orchestrations

"Concurrent orchestrations" = in-flight workflow runs. Each run is mostly
**wall-clock-bound on the SSH'd agent** (minutes to hours — PROJECT_BRIEF: "an hour
per task or six hours"), with bursty DB writes (events, cost_records, state
transitions) and a long-lived SSE viewer or two. Each step's binding constraint is
named against the **current** design, with the concrete change.

### 10 concurrent — works today, essentially unchanged

- **Binding constraint:** none that bites. `DEFAULT_CONCURRENCY = 2` is the only
  obstacle, and it's a config bump. One Postgres, one pool, one worker process
  handle 10 easily; the runs are agent-bound, not DB-bound.
- **Change:** raise worker concurrency; size the pool (`new Pool` takes a `max`).
  `LISTEN/NOTIFY` is already wired (`db/src/notify.ts`), so the worker and SSE are
  event-driven, not 1s-polling — that latency + load win is banked.

### 100 concurrent — first real pressure: the shared pool & in-process worker

- **Binding constraint:** the **single in-process worker + single shared pool**.
  100 concurrent runs means 100 live SSH sessions orchestrated from one Node event
  loop, plus 100 SSE streams, plus the worker — all on _one_ pool. Pool
  exhaustion and event-loop contention (one process doing fan-out + execution +
  HTTP) are the first ceilings.
- **Change:** (a) **split the worker out of the HTTP process** into a small fleet
  (the flag → a deployment boundary; the queue already supports N claimers via
  `SKIP LOCKED`). (b) a **pooler** (PgBouncer/transaction pooling) so worker + API + SSE don't
  fight over one `pg.Pool`. Postgres itself is nowhere near its ceiling here.

### 1,000 concurrent — Postgres write contention & job-queue hot rows

- **Binding constraint:** **Postgres write load + queue contention on a single
  primary.** 1,000 runs emit high-rate `events`, `cost_records`, and `job_queue`
  churn. `cost_records` is an append-heavy ledger (a row per LLM call); `events` is
  append-only audit; the `FOR UPDATE SKIP LOCKED` claim contends on the hot
  "queued" rows. SSE fan-out is now thousands of streams — even with `LISTEN/NOTIFY`
  wake, thousands of LISTEN connections on one primary want a dedicated event-bus
  fan-out tier. Single-primary write throughput is the wall.
- **Change:**
  - **Read replicas** for the dashboard/DORA/cost/SSE read paths (read-mostly per
    PROJECT_BRIEF §6.5) — offload the primary. The data-access layer (§1) is what
    makes "route reads to a replica" a one-place change instead of 269.
  - **Partition the hot append tables** (`events`, `cost_records`) by time and/or
    `org_id`; partition or sleeve the `job_queue` by `task_kind` / shard so
    claimers contend on disjoint row sets.
  - **An event bus / fan-out tier** for SSE (the edge plane, §3): the worker
    publishes run deltas once; an edge tier fans out to N subscribers, instead of
    N subscribers each polling Postgres.
  - **Backpressure via the walker's admission point.** The DagWalker already gates
    new work on the budget ceiling (`engine/dag/budgetGate.ts`) before spawning
    runs; that scheduling chokepoint is where a load-shedding valve (a concurrency
    or spend cap that defers rather than spawns) belongs at this scale. There is no
    separate quota-admission seam — budget is the only gate today.

### 1,000,000 concurrent — single-Postgres is the wall; shard or split planes

- **Binding constraint:** **a single Postgres instance, full stop.** No partition
  scheme, replica fan, or pooler keeps one primary serving the write rate of 1M
  concurrent agent orchestrations. Every "single X" in the current design is now
  the ceiling simultaneously: single pool, single primary, single queue table,
  single event store, in-process anything.
- **Change (the SaaS / multi-region end-state, deliberately far past the current
  product):**
  - **Tenant sharding:** partition orgs across many Postgres clusters
    (shard-by-`org_id`) — _only_ sane if isolation is already RLS-enforced and all
    access is org-scoped through the data-access seam, which is exactly why §1 + §3
    - the RLS plan are prerequisites, not afterthoughts.
  - **A distributed / partitioned-per-shard queue** rather than one `job_queue`
    table. The `JobQueue` _contract_ + conformance suite is the asset: a
    Kafka/NATS/partitioned-PG impl slots behind the same interface the in-process
    claimer satisfies today — no workflow-code rewrite.
  - **First-class control/data/edge planes**, independently scaled fleets, edge on
    a dedicated pub/sub bus.
  - **Cost-recording as a streaming write path** (batched/async ingestion into a
    columnar store for the metering-export reads) rather than a synchronous row per
    LLM call.

**The throughline:** every ceiling above is a **"single"** in today's design, and
every fix is enabled by a **contract** that already exists (RLS and `LISTEN/NOTIFY`
now among them) or by the **data-access seam** that doesn't yet. The
conformance-suited seams (`JobQueue`, `EventStore`, `Allocator`, `SecretStore`) are
the ones that scale by impl-swap with no rewrite; the un-seamed surfaces (raw SQL
data access, the in-process worker) are the ones that force code change at each
step. **That asymmetry
is the entire argument for the early moves in §7.**

---

## 5. Maximum security / zero-trust end-state

The end-state posture, framed as an extension of the RLS + plane-split direction
(which it co-requires — you cannot run a worker fleet + control plane against
shared tenant data without it):

- **Database least-privilege + RLS (the foundation).** Tenant isolation moves from
  ~269 hand-written `org_id` predicates into **Postgres RLS policies** keyed on a
  session-set `org_id`, with **least-privilege roles per plane** (control: read +
  enqueue; data: claim + write run/event/cost; edge: read-only on the published
  stream). RLS is the structural fix for the single-omitted-`WHERE` leak (§0/§1)
  and the precondition for safe sharding (§4). _Owned by the RLS plan; named here
  as the security keystone._
- **Per-run scoped credentials, never ambient.** PROJECT_BRIEF §8 already mandates
  per-session injection (no host creds, no env-at-startup, credentials read on
  demand and transported per SSH session, files at 0600 in tmpfs, destroyed on
  teardown). The zero-trust extension: each run gets a **short-lived, narrowly
  scoped credential lease** (the GitHub-App-per-org direction in MEMORY over PATs;
  per-run minted tokens over long-lived secrets), revocable mid-run, with the
  `SecretStore` conformance seam ensuring every backend (Vault, pgcrypto, cloud
  secret managers — the `awsSecretsManager`/`gcpSecretManager`/`onePassword`
  contracts already exist) enforces the same lease semantics.
- **mTLS everywhere between planes.** Once control/data/edge are separate fleets
  (§3), the `internalRpc` seam becomes a network boundary — **mutually
  authenticated** (mTLS + per-plane identity), not localhost-trust. The substrate
  SSH layer already pins host keys (`host_key_fingerprint`); extend that "pin,
  don't trust" posture to every inter-plane hop.
- **Untrusted-runner containment.** Runners execute agent-authored code — the
  untrusted edge. Containment hardens along the no-host-code invariant (§1.2):
  per-runner egress policy (reach the SCM + LLM endpoint and _nothing else_), no
  orchestrator creds resident beyond the per-session lease, only inbound is the
  pinned-key SSH session. A compromised runner exfiltrates at most its own run's
  short-lived leased creds.
- **Secret isolation by plane + tenant.** No plane holds more secret scope than its
  job needs (the data plane never sees control-plane signing keys); one tenant's
  secret material is unreachable from another's run even on a shared cluster
  (RLS + per-tenant namespacing in the `SecretStore`).

The posture is a strict superset of where the RLS + plane-split plan is heading —
zero-trust is "the plane split, but every boundary mutually authenticated and every
credential scoped to the smallest blast radius."

---

## 6. Strictly tested & proven — keeping correctness through the refactor

The longevity doc commits the philosophy (behavior/contract tests over impl tests;
conformance suites per seam; neutral schemas; Stryker). This is the **pre-rewrite
checklist**: what must _exist and be green_ **before** a Rust line is written, so
the new impl is _provably_ equivalent, not hopefully-equivalent.

**What exists today (the proven base):**

- Behavior tests through public contracts (`app.request` HTTP, DB state, event
  stream) — refactor-safe by construction.
- Conformance suites for **4 seams** (`Allocator`, `JobQueue`, `EventStore`,
  `SecretStore`) — any impl, incl. a future Rust one, must pass the _same_ suite
  (the strangler-fig enabler).
- The JSON-Schema export + drift gate (`check:contract-schema-drift`) — the neutral
  spec a serde port generates from. Stryker mutation testing (`just mutation`,
  ~40% scope floor) — test _strength_ as a number, with a regression ratchet.

**What must exist BEFORE the rewrite (the gaps to close first):**

1. **Conformance suites for the remaining load-bearing seams.** Today only 4 of the
   seams are conformance-covered. Before porting, the **data-access layer**
   (§1, doesn't exist as a seam yet), the **`SshSubstrate`**, the **provider/
   harness adapters**, and **`CostResolver`** each need a shared conformance suite.
   _You cannot prove a Rust impl equivalent to a seam that has no equivalence
   suite._
2. **Golden behavior fixtures for the full workflow loop.** Recorded request/
   response pairs, golden event sequences, and run-state snapshots for the
   canonical plan→write→check→audit→PR→CI→merge loop (PROJECT*BRIEF §2). These are
   the executable spec a Rust port must reproduce **byte-for-byte** on the
   contract surface. Some exist (fixture workflows under `tests/`); the gap is
   \_completeness across every terminal outcome* (merged / failed / quota_exceeded /
   recovered).
3. **DB row contracts in the JSON-Schema export** (§2) — so a Rust repository impl
   generates its row types from the same neutral source the TS one validates
   against, and the data-access conformance suite checks both against it.
4. **A continuous serde-generation CI check** (§2.3): run `typify` over
   `contracts/json/**` on every PR. The day it fails is the day the schema drifted
   out of Rust-portability — caught years before the rewrite, not during it.
5. **Raise the mutation-score floor on the seams a Rust impl will replace first.**
   The longevity doc flags `engine/credentials/**` (~33%) and several allocators
   (0% under Stryker) as the weakest. A seam you intend to re-implement in Rust
   must have a _strong_ conformance + mutation bar first, or "green in Rust" proves
   nothing.

**The rule:** a seam is rewrite-ready only when **(conformance suite) +
(golden behavior fixtures) + (neutral schema) + (mutation floor)** are all green
for it. Port seams in that-order-of-readiness, one at a time, strangler-fig style —
each one shipped only after it passes the _identical_ suite the TS impl passes.

---

## 7. Biggest risks & highest-leverage early moves

**Decisions are deferred — but some moves are worth doing NOW because they make the
future refactor feasible regardless of which future arrives, and pay for themselves
immediately in the current system.**

### Highest-leverage early moves (do these now)

1. **Build the data-access layer (`engine/data/**`) and collapse the ~269 raw SQL
sites behind it, org-scoped by construction.** The single highest-leverage move:
(a) removes the cross-tenant-leak risk of hand-written `org*id` predicates,
   (b) becomes the seam RLS hardens and a Rust repositories crate slots behind,
   (c) makes "route reads to a replica" / "shard by org" a one-place change at
   1k/1M scale, (d) unsticks the 500-line files mixing querying with mapping.
   \_Nothing else here is feasible at scale without it.*
2. **Generate the dashboard's client types from the JSON-Schema export + add a
   drift gate.** Eliminate the hand-mirrored `api/*Types.ts` (the largest type-
   sharing gap), prove end-to-end type sharing today, and make the BFF↔orchestrator
   contract un-driftable.
3. **Add DB row contracts to `contracts/json/**`and a continuous`typify`
   generation check.\*\* Makes the neutral schema cover the whole contract surface
   and proves continuous Rust-portability — for free, in CI, before any rewrite.
4. **Backfill conformance suites for `SshSubstrate`, the provider/harness adapters,
   `CostResolver`, and the new data-access seam.** Extends the proven-equivalence
   base from 4 seams toward "every load-bearing seam," which is the precondition
   for §6.

### Biggest risks

- **Tenant isolation by hand-written predicate.** The current 269-site `org_id`
  filtering is one omission from a cross-org leak, and it gets _worse_ the moment a
  worker fleet + control plane run in parallel against shared data. **RLS + the
  data-access seam are not optional before any plane split.** This is the top
  risk.
- **Rewriting before the equivalence harness exists.** Porting a seam that lacks a
  conformance suite + golden fixtures + mutation floor means "green in Rust" proves
  nothing. The risk is a confident-but-wrong port. §6's checklist is the mitigation;
  the order (harness first, port second) is non-negotiable.
- **Premature plane-splitting.** Splitting planes before scale forces it (and
  before RLS lands) buys distributed-systems complexity with no payoff and a new
  isolation hole. Let §4's bottleneck analysis trigger each split; don't pre-build.
- **Schema-drift across the three type representations.** Zod, JSON-Schema, and the
  hand-mirrored dashboard types can silently diverge today (only Zod↔JSON-Schema is
  gated). Until move #3 lands, a contract change can ship a dashboard that
  type-checks against a stale mirror.
- **The 500-line cap as a false floor.** The cap surfaces over-grown modules
  correctly, but "split the file to pass the gate" without consolidating behind a
  contract just scatters the same coupling. Treat each at-cap file as a _design_
  signal (it does two jobs) — e.g. `routes/runs/list.ts` (query + mapping) and
  `dashboard/api/types.ts` (the whole re-derived contract).

---

## Appendix: the map in one line per layer

| Layer            | Today (real)                                              | Forces a change at | Fix                                       |
| ---------------- | --------------------------------------------------------- | ------------------ | ----------------------------------------- |
| Data access      | ~269 raw SQL sites, hand-typed rows, hand `org_id` filter | 100 → 1k → 1M      | data-access layer (§1) + RLS (§3/§5)      |
| Worker           | in-process, event-driven (`NOTIFY`), flagged off          | 100                | split to fleet (queue supports it)        |
| Queue            | PG `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY` wired       | 1k → 1M            | partition; impl-swap seam                 |
| DB               | one primary, one shared pool                              | 100 → 1k → 1M      | pooler → replicas → partition → shard     |
| SSE / fan-out    | `NOTIFY`-wake per stream (1s poll gone)                   | 1k                 | event-bus edge plane at high stream count |
| Type sharing     | Zod→JSON-Schema gated; dashboard re-derives by hand       | now (correctness)  | gen FE types from JSON-Schema (§2)        |
| Tenant isolation | Postgres RLS (denies by default) + org-scoped client      | done               | RLS enforced; sharding follows at 1M      |
| Proof of port    | 4 conformance seams + Stryker + JSON-Schema export        | before rewrite     | conformance for all seams + fixtures      |
