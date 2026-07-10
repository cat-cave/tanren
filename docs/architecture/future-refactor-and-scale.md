# Future-refactor & scale north-star (10 → 1M, zero-trust)

**Status: analysis / scoping. No build is authorized by this doc.** A Rust rewrite is **HELD**.
(Update: the RLS + control/data-plane split this doc once called "plan-only" has shipped — RLS
fully enforced + live-validated, the plane split complete through Vault per-run scoped credentials,
`LISTEN/NOTIFY` replaced the 1s polling, and **the data-access `Repositories` seam has shipped**
(contract + pg impl + conformance suite `repositoriesConformance.ts`); the remaining data-access
work is **adoption** — moving the still-raw read paths onto it — not standing the seam up. The
remaining prepwork below — the DB-row JSON-Schema export, conformance for the last un-seamed
surfaces — is the live to-do.) This is the _map_ of the binding constraints in the **real current
architecture** and the highest-leverage moves that make the eventual refactor feasible. Decisions
are deferred.

It builds on, and does **not** duplicate:

- [`portability-and-longevity.md`](./portability-and-longevity.md) — the existing
  north star (contracts-as-durable-asset, JSON-Schema export, conformance suites,
  mutation testing, harness protocol, the OSS↔hosting billing seam). Read it first.
- [`ROADMAP.md`](../../ROADMAP.md) — the SaaS hardening history (RLS denies-by-default,
  control/data-plane split, Vault per-run scoped credentials, `42501`-proven). This doc tells you
  _what scale forces_ the plane split to become; the roadmap records it as done.
- [`PROJECT_BRIEF.md`](../../PROJECT_BRIEF.md) — the durable vision and the eight
  architectural invariants (§1.2), which constrain every option below.

The governing principle is unchanged from the longevity doc: **make the contracts
the durable asset and the implementation disposable.** Everything here is in
service of keeping that true as the system grows three to six orders of magnitude.

---

## 0. Where the real system is today (grounding)

Read before trusting any claim below. The shape, as actually built on `main`:

- **Control/data-plane split.** The HTTP control plane (`main.ts`) and standalone
  run-executor data plane (`worker-main.ts`) are separate processes/services. The
  API starts an in-process worker only for the `TANREN_RUN_WORKER=1` single-process
  development convenience; each process constructs its own database pool.
- **The queue is Postgres-native and already correct in shape.**
  `engine/contracts/jobQueue.ts` `claim()` is the textbook
  `… FOR UPDATE SKIP LOCKED LIMIT 1` CTE + CAS to `running` with a lease
  (`leased_until`, `heartbeat_at`), reaped by `engine/worker/jobReaper.ts`.
  **`LISTEN/NOTIFY` is wired** (`db/src/notify.ts`, channel `tanren_run`): every
  run-state write fires a `NOTIFY` at commit, and the worker + SSE stream wake on it
  rather than polling — the 1s hot poll is gone.
- **The `Repositories` data-access seam has shipped; raw-SQL adoption is partial.**
  The orchestrator does **not** use Drizzle as its query layer — Drizzle lives in
  `db/` for the schema + migrations only. The `Repositories` contract
  (`engine/contracts/repositories.ts`) now aggregates the per-entity stores under
  `engine/repositories/**` (actors/jobs/runs/specs/tasks/projects/costs/events/…)
  into one slottable seam — a contract + pg impl + conformance suite
  (`tests/conformance/repositoriesConformance.ts`), the shape `JobQueue`/`EventStore`
  already have. Each store method takes an explicit `QueryClient` + `ActorRef`, and
  each row is Zod-validated (e.g. `engine/repositories/runs.ts`). **What remains is
  adoption:** ~**85 files still issue raw `.query(...)`** (≈71 on `routes/**` +
  `engine/**` read paths — route loaders, SSE, DORA, costs, insights), plus the two
  forge stores (`forge/audits/store.ts` + `forge/inbox/store.ts`). The seam exists;
  collapsing the remaining read sites behind it is the live work.
- **Tenant isolation is Postgres-RLS-enforced.** `org_id` is `NOT NULL` on the core
  tables and **RLS policies deny by default** keyed on a session-set org (see
  `db/src/orgScope.ts`): a query off the org-scoped client sees zero cross-tenant
  rows even if a hand-written `WHERE org_id = $n` is forgotten. Loaders still carry
  the predicate as defense-in-depth, but the database is now the isolation backstop.
  (The collapsed baseline `0000_collapsed_baseline.sql` carries the `NOT NULL`
  constraints + RLS policies; the old per-migration numbers are gone.)
- **The dashboard is a BFF; type sharing is partial.**
  `services/dashboard` (Hono SSR + esbuild-built client "islands") does **not** read
  Postgres for product data; it `fetch()`es the orchestrator (`ORCHESTRATOR_URL`)
  through typed clients in `src/api/*Client.ts`. **Run-detail HTTP shapes** are
  **codegen'd** from `contracts/json/http/**` into `src/api/http.gen.ts`
  (`scripts/gen-dashboard-types.mjs`) and re-exported from `src/api/types.ts`, with
  a `check:dashboard-types-drift` gate. Remaining `src/api/*Types.ts` modules
  (audits/dag/discovery/inbox/onboarding/…) and non-run-detail types in `types.ts`
  are still **hand-mirrored**. `api/types.ts` is under the 500-line cap (~466) —
  run-detail extraction into `http.gen.ts` relieved the prior pin-at-cap.
- **Contracts already exist as a neutral artifact.** Zod is the authoring tool;
  `contracts/json/**` is the exported JSON-Schema (events/state/answerers/http/
  insights), regenerated by `scripts/contract-schema-export.mjs` and pinned by the
  `check:contract-schema-drift` gate. DB row shapes are **not** in that export (they
  live as Drizzle tables, neutral via SQL migrations + the schema-drift gate).
- **~21 seams have conformance suites.**
  `services/orchestrator/tests/conformance/**` now carries ~21 shared suites —
  `Allocator`, `JobQueue`, `EventStore`, `SecretStore`, `CostResolver`,
  `Repositories`, the four VCS/merge seams (`WorkspaceVcsCore`, `CodeHost`,
  `MergeAuthority`, `VisibilityProjection`), `DagWalker`, `MergeCoordinator`,
  `CommandSubstrate`, the integration provisioner, … — each a suite any impl
  (fake / real / future Rust) must pass. Stryker is wired (`just mutation`, **break
  floor 42%** per `stryker.config.mjs`). A few surfaces (`NotificationOutbox`, the
  provider/harness adapters, `GitHubHttpClient`) still lack one.
- **The 500-line cap is real and biting.** `scripts/check-architecture.mjs` fails
  any source file over 500 lines (`file-line-max-500`). Hotspots still sit near the
  cap (`routes/runs/list.ts`, `reviewMerge/mergeDispatch.ts`, `providers/github.ts`,
  `routes/forge/index.ts`). Dashboard `api/types.ts` is no longer pinned at 500.
  The cap surfaces modules that have outgrown their boundary.

---

## 1. Code structuring — the ideal module/package shape

### Where the current structure strains

1. **Partial data-access-seam adoption (the largest remaining structural debt).**
   The `Repositories` seam now **exists** — contract + pg impl + conformance
   (`tests/conformance/repositoriesConformance.ts`), covering stores under
   `engine/repositories/**`. Debt is **incomplete adoption**: ~85 files still issue
   raw `.query(...)` (mostly **read** paths + forge stores). Strain:
   **correctness** (hand-written `WHERE org_id`; RLS backstop §3/§5), **refactor
   cliff**, **test surface** (only migrated paths in conformance). Fix is finishing
   adoption, not building the seam.
2. **500-line-cap pressure points** are the structural smell, not the problem.
   Files near the cap (`routes/runs/list.ts`, `mergeDispatch.ts`, …) do two jobs
   (e.g. query layer _and_ row-mapper). Dashboard run-detail is already in
   `http.gen.ts`; residual `api/*Types.ts` modules remain dual-maintained.
3. **Provider adapters duplicate endpoint/credential/cost wiring.**
   `providers/{claude,codex,opencode,aider}.ts` repeat base-URL override, credential
   materialization, and token-usage parsing. Harness protocol (longevity §4) is the
   consolidation target.

### The ideal shape (a target, not a sprint)

Keep the **multi-service / multi-seam** boundary that already exists
(orchestrator / dashboard / db over HTTP+SQL+SSH+events) — it is the asset. Refine
_within_ it:

- **Finish the data-access layer behind the shipped `Repositories` seam, one
  method per query intent, one row-mapper per table.** The seam, the pg impl, and
  the conformance suite (`repositoriesConformance.ts`) already **exist**; collapse
  the ~85 still-raw sites behind it. Every method takes a `QueryClient` + acting
  `ActorRef`, so org scope is carried structurally (RLS as backstop). This is the
  seam a Rust crate slots behind, and **the highest-leverage remaining adoption
  move** (see §7).
- **One neutral contract package the dashboard consumes** (finish killing the
  hand-mirrored `api/*Types.ts`): run-detail is already generated into `http.gen.ts`
  with a drift gate (§2); extend that pipeline to the remaining surface modules.
- **Crate-shaped module boundaries now, in TS.** Structure the engine as if each
  major seam were already a separate publishable unit (`contracts`, `data`, `queue`,
  `substrate`, `providers`, `workflow`, `costs`). The TS module graph is the dry-run
  of the eventual Rust crate graph — a clean boundary today is a `Cargo.toml` member
  later; a leaky one is a rewrite.

The test: **could you replace one engine module with a Rust binary, behind its
contract, and prove it green against the same conformance + behavior tests?** True
today for ~21 seams (`JobQueue`/`EventStore`/`Repositories`/`CostResolver`/the four
VCS-merge seams/…); the structuring north star is finishing **data-access adoption**
and closing the last un-seamed surfaces.

---

## 2. Type generation & sharing backend ↔ frontend

### Today

- **Authoring:** Zod, in the orchestrator. **Neutral artifact:** `contracts/json/**`
  JSON-Schema, draft-2020-12, drift-gated. **Rust path:** documented as
  `contracts/json/**` → `typify` → `serde` (longevity doc §3). All good and
  already shipped for events/state/answerers/http/insights.
- **Partial progress (run-detail):** `scripts/gen-dashboard-types.mjs` emits
  `services/dashboard/src/api/http.gen.ts` from `contracts/json/http/**`;
  `check:dashboard-types-drift` fails CI on divergence; `api/types.ts` re-exports.
- **The remaining gap:** other dashboard modules still **re-derive types by hand**
  (`api/*Types.ts` for audits/dag/discovery/inbox/onboarding/…, plus non-run-detail
  shapes in `types.ts`) — a third hand-maintained copy with no per-module drift
  gate. DB row shapes are also outside the JSON-Schema export (neutral only via
  Drizzle migrations + the SQL drift gate — fine for SQL, not shared TS/serde).

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
insights` are exported; DB rows are not. Promote the per-table Zod row validators
   (the `RunRow`-style schemas in `engine/repositories/**`) into the catalog so row
   shapes become first-class neutral contracts — a prerequisite for §1.
2. **Extend dashboard client-type generation** beyond the already-shipped
   run-detail slice (`http.gen.ts` + `check:dashboard-types-drift`) so remaining
   hand-mirrored `api/*Types.ts` modules regenerate from `contracts/json/http/**`.
   The first cut unstuck the prior 500-line pin on `api/types.ts`; finishing the
   surface closes the residual type-sharing gap.
3. **Pin the Rust serde generation in CI _before_ a Rust line is written** (§6):
   run `typify` over `contracts/json/**` in a check job that fails if generation
   errors — proving the neutral schema is _continuously Rust-portable_, so the
   rewrite starts on known-good types rather than discovering drift during the port.

End state: a Rust backend (serde) and the TS frontend **share one neutral schema
source**; drift is a CI failure in every direction; nobody hand-maintains a type
mirror. **Known carve-out** (longevity doc): the harness-protocol I/O shapes
(`WriterResult`, `TokenUsage`, `AnswererRunOptions`) are TS `interface`s, not Zod —
promoting them to Zod closes the last hand-typed contract boundary.

---

## 3. Architecture restructuring — is the monolith the right shape?

**For now: keep the standalone worker data plane.** Scale the existing standalone
worker data plane horizontally; the Postgres `FOR UPDATE SKIP LOCKED` queue is
the coordination seam. Don't pre-split; let the bottleneck analysis (§4) trigger
each step. The planes that want to become first-class, in the order scale forces
them:

- **Data plane (worker fleet) first.** The worker's run-executor claim loop is
  already isolated in `worker-main.ts`. Promoting it to a horizontal fleet (N
  processes running the same `runSlot` against the same `FOR UPDATE SKIP LOCKED`
  queue) is the lowest-friction split — the queue contract was built for exactly
  this, and the SSH substrate already makes the _execution_ remote. Caveat: the
  worker process also co-hosts the per-process autonomy loops (`bootRunWorker` →
  `startAutonomyLoops`): the live DagWalker subscriber, the intake poller, and the
  audit scheduler — NONE queue-coordinated. Running N worker processes first needs
  those loops elected to a singleton (or given their own claim-coordination), else
  they duplicate across the fleet. Only the run-executor claim loop is naively N-safe today.
- **Control plane (HTTP API + dashboard BFF) second.** Stateless handlers scale
  horizontally trivially once they stop sharing a process with the worker. The
  `internalRpc.ts` contract (`createRun`/`getRun`) is the already-defined seam
  between "accept work" (control) and "execute work" (data).
- **Edge plane (SSE/event fan-out) third**, when connection count is the constraint.

**Tie-in, not duplication:** the **RLS direction is what makes the plane split
safe.** A worker fleet + a control-plane API touching one Postgres is only
tenant-safe if isolation is enforced _in the database_ (RLS keyed on a session-set
`org_id`), not in hand-written `WHERE` clauses spread across parallel processes.
**RLS landed first (enforced today), so scaling the worker's run-executor loop into a
fleet is now tenant-safe** — the shipped policies (`db/src/orgScope.ts` + the collapsed
baseline) own the session-variable / role mechanics. (The co-hosted autonomy loops
still need singleton coordination before N worker processes, per the §2 caveat — RLS
makes the split _tenant_-safe, not the autonomy loops _duplication_-safe.)

---

## 4. Scale path: 10 → 100 → 1,000 → 1,000,000 concurrent orchestrations

"Concurrent orchestrations" = in-flight workflow runs. Each run is mostly
**wall-clock-bound on the SSH'd agent** (minutes to hours — PROJECT_BRIEF: "an hour
per task or six hours"), with bursty DB writes (events, cost_records, state
transitions) and a long-lived SSE viewer or two. Each step's binding constraint is
named against the **current** design, with the concrete change.

### 10 concurrent — works today, essentially unchanged

- **Binding constraint:** none that bites. `DEFAULT_CONCURRENCY = 2` is the only
  obstacle, and it's a config bump. One Postgres and a single worker process (with
  its own pool, separate from the API's) handle 10 easily; the runs are agent-bound,
  not DB-bound.
- **Change:** raise worker concurrency; size the pool (`new Pool` takes a `max`).
  `LISTEN/NOTIFY` is already wired (`db/src/notify.ts`), so the worker and SSE are
  event-driven, not 1s-polling — that latency + load win is banked.

### 100 concurrent — first real pressure: the worker's pool + event loop

- **Binding constraint:** the **worker process's own pool + its single event loop**
  (the API is a separate process with its own pool since the control/data-plane split,
  so this is per-process, not one global pool). 100 concurrent runs means 100 live SSH
  sessions orchestrated from one worker event loop, plus the SSE fan-out on the API
  side — the worker's pool exhaustion and its event-loop contention are the first ceilings.
- **Change:** (a) **scale the worker fleet horizontally** (the queue already
  supports N claimers via `SKIP LOCKED`). (b) a **pooler** (PgBouncer/transaction
  pooling) so worker + API + SSE don't fight over one `pg.Pool`. Postgres itself
  is nowhere near its ceiling here.

### 1,000 concurrent — Postgres write contention & job-queue hot rows

- **Binding constraint:** **Postgres write load + queue contention on a single
  primary.** 1,000 runs emit high-rate `events`, `cost_records`, and `job_queue`
  churn. `cost_records` is an append-heavy ledger (a row per LLM call); `events` is
  append-only audit; the `FOR UPDATE SKIP LOCKED` claim contends on the hot
  "queued" rows. SSE fan-out is now thousands of streams — even with `LISTEN/NOTIFY`
  wake, thousands of LISTEN connections on one primary want a dedicated event-bus
  fan-out tier. Single-primary write throughput is the wall.
- **Change:**
  - **Read replicas** for the dashboard/DORA/cost/SSE read paths — offload the
    primary. The data-access layer (§1) is what makes "route reads to a replica" a
    one-place change instead of ~85.
  - **Partition the hot append tables** (`events`, `cost_records`) by time and/or
    `org_id`; partition or sleeve the `job_queue` by `task_kind` / shard so
    claimers contend on disjoint row sets.
  - **An event bus / fan-out tier** for SSE (the edge plane, §3): the worker
    publishes run deltas once and an edge tier fans out to N subscribers, instead of
    N subscribers each polling Postgres.
  - **Backpressure via the walker's admission point.** The DagWalker already gates
    new work on the budget ceiling (`engine/dag/budgetGate.ts`) before spawning
    runs; that chokepoint is where a load-shedding valve (a concurrency or spend cap
    that defers rather than spawns) belongs — budget is the only gate today.

### 1,000,000 concurrent — single-Postgres is the wall; shard or split planes

- **Binding constraint:** **a single Postgres instance, full stop.** No partition
  scheme, replica fan, or pooler keeps one primary serving the write rate of 1M
  concurrent agent orchestrations. Every "single X" in the current design is now
  the ceiling simultaneously: per-process pools, single primary, single queue table,
  single event store, un-sharded everything.
- **Change (the SaaS / multi-region end-state, deliberately far past the current
  product):**
  - **Tenant sharding:** partition orgs across many Postgres clusters
    (shard-by-`org_id`) — _only_ sane if isolation is already RLS-enforced and all
    access is org-scoped through the data-access seam, which is exactly why §1 + §3
    - the RLS plan are prerequisites, not afterthoughts.
  - **A distributed / partitioned-per-shard queue** rather than one `job_queue`
    table. The `JobQueue` _contract_ + conformance suite is the asset: a
    Kafka/NATS/partitioned-PG impl slots behind the same interface the PG
    `SKIP LOCKED` claimer satisfies today — no workflow-code rewrite.
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
data access, the worker's co-hosted autonomy loops) are the ones that force code
change at each step. **That asymmetry
is the entire argument for the early moves in §7.**

---

## 5. Maximum security / zero-trust end-state

The end-state posture, framed as an extension of the RLS + plane-split direction
(which it co-requires — you cannot run a worker fleet + control plane against
shared tenant data without it):

- **Database least-privilege + RLS (the foundation).** Tenant isolation moves from
  the remaining hand-written `org_id` predicates into **Postgres RLS policies** keyed on a
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
  job needs (the data plane never sees control-plane signing keys); a tenant's
  secret material is unreachable from another's run even on a shared cluster (RLS +
  per-tenant `SecretStore` namespacing).

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
- Conformance suites for **~21 seams** (`Allocator`, `JobQueue`, `EventStore`,
  `SecretStore`, `CostResolver`, `Repositories`, the four VCS/merge seams,
  `DagWalker`, `MergeCoordinator`, `CommandSubstrate`, …) — any impl, incl. a
  future Rust one, must pass the _same_ suite (the strangler-fig enabler).
- The JSON-Schema export + drift gate (`check:contract-schema-drift`) — the neutral
  spec a serde port generates from. Stryker mutation testing (`just mutation`,
  **break floor 42%**) — test _strength_ as a number, with a regression ratchet.

**What must exist BEFORE the rewrite (the gaps to close first):**

1. **Conformance suites for the last un-covered load-bearing seams.** The seam set
   is now broad (~21 suites, incl. the **`Repositories`** + **`CostResolver`** seams
   that used to be listed as gaps here). The remaining holes — the **provider/harness
   adapters**, **`NotificationOutbox`**, **`GitHubHttpClient`** — each still need a
   suite before a Rust port (you cannot prove a Rust impl equivalent to a seam with
   no equivalence suite).
2. **Golden behavior fixtures for the full workflow loop.** Recorded request/
   response pairs, golden event sequences, and run-state snapshots for the canonical
   plan→write→check→audit→PR→CI→merge loop (PROJECT*BRIEF §2) — the executable spec
   a Rust port must reproduce **byte-for-byte** on the contract surface. Some exist
   (fixture workflows under `tests/`); the gap is \_completeness across every terminal
   outcome* (merged / failed / quota_exceeded / recovered).
3. **DB row contracts in the JSON-Schema export** (§2) — so a Rust repository impl
   generates row types from the same neutral source the TS one validates against.
4. **A continuous serde-generation CI check** (§2.3): run `typify` over
   `contracts/json/**` on every PR. The day it fails is the day the schema drifted
   out of Rust-portability — caught years before the rewrite, not during it.
5. **Raise the mutation-score floor on the seams a Rust impl will replace first.**
   The longevity doc flags `engine/credentials/**` (~33%) and several allocators
   (0% under Stryker) as weakest; a seam you intend to re-implement in Rust needs a
   _strong_ conformance + mutation bar first, or "green in Rust" proves nothing.

**The rule:** a seam is rewrite-ready only when **(conformance suite) +
(golden behavior fixtures) + (neutral schema) + (mutation floor)** are all green
for it. Port seams in that order of readiness, one at a time, strangler-fig style —
each shipped only after it passes the _identical_ suite the TS impl passes.

---

## 7. Biggest risks & highest-leverage early moves

**Decisions are deferred — but some moves are worth doing NOW because they make the
future refactor feasible regardless of which future arrives, and pay for themselves
immediately in the current system.**

### Highest-leverage early moves (do these now)

1. **Finish data-access-seam adoption — collapse the ~85 still-raw SQL sites behind
   the shipped `Repositories` seam, org-scoped by construction.** The seam (contract +
   pg impl + conformance suite) is **DONE**; migrating the still-raw read paths onto it
   (a) removes the cross-tenant-leak risk of hand-written `org_id` predicates,
   (b) lands every read on the seam RLS hardens and a Rust crate slots behind,
   (c) makes "route reads to a replica" / "shard by org" a one-place change at
   1k/1M scale, (d) unsticks the 500-line files mixing querying with mapping.
   _Nothing else here is feasible at scale without it._
2. **Finish generating the dashboard's client types from the JSON-Schema export.**
   Run-detail is already codegen'd into `http.gen.ts` with
   `check:dashboard-types-drift`. Extend that pipeline to remaining hand-mirrored
   `api/*Types.ts` modules so the whole BFF↔orchestrator contract is un-driftable.
3. **Add DB row contracts to `contracts/json/**`and a continuous`typify`
   generation check.\*\* Makes the neutral schema cover the whole contract surface
   and proves continuous Rust-portability — for free, in CI, before any rewrite.
4. **DONE: `CostResolver` + the data-access (`Repositories`) seam are now
   conformance-covered** (`costResolverConformance.ts`, `repositoriesConformance.ts`),
   alongside `CommandSubstrate`. What remains to backfill is the provider/harness
   adapters, `NotificationOutbox`, and `GitHubHttpClient` — extending the
   proven-equivalence base toward "every load-bearing seam," the precondition for §6.

### Biggest risks

- **Tenant isolation by hand-written predicate on the un-migrated reads.** The
  ~85 still-raw `.query(...)` sites each lean on a hand-written `org_id` filter, one
  omission from a cross-org leak, and it gets _worse_ the moment a worker fleet +
  control plane run in parallel against shared data. RLS (shipped) is the backstop;
  finishing `Repositories`-seam adoption removes the hand-written predicate
  entirely. This is the top remaining adoption risk.
- **Rewriting before the equivalence harness exists.** Porting a seam that lacks a
  conformance suite + golden fixtures + mutation floor means "green in Rust" proves
  nothing. The risk is a confident-but-wrong port. §6's checklist is the mitigation;
  the order (harness first, port second) is non-negotiable.
- **Premature plane-splitting.** Splitting planes before scale forces it (and
  before RLS lands) buys distributed-systems complexity with no payoff and a new
  isolation hole. Let §4's bottleneck analysis trigger each split; don't pre-build.
- **Schema-drift across the three type representations.** Zod↔JSON-Schema is gated,
  and run-detail is gated via `http.gen.ts` / `check:dashboard-types-drift`.
  Residual hand-mirrored `api/*Types.ts` can still diverge until move #2 finishes.
- **The 500-line cap as a false floor.** The cap surfaces over-grown modules
  correctly, but "split the file to pass the gate" without consolidating behind a
  contract just scatters the same coupling. Treat each near-cap file as a _design_
  signal (it does two jobs) — e.g. `routes/runs/list.ts` (query + mapping). The
  prior `dashboard/api/types.ts` pin was relieved by `http.gen.ts`; finish that
  pattern for residual mirrors.

---

## Appendix: the map in one line per layer

| Layer            | Today (real)                                                                                               | Forces a change at | Fix                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| Data access      | `Repositories` seam shipped; ~85 raw `.query` sites unmigrated                                             | 100 → 1k → 1M      | finish seam adoption (§1) + RLS (§3/§5)            |
| Worker           | standalone (`worker-main.ts`), `NOTIFY`-wake; run-executor loop fleet-ready, autonomy loops need singleton | 100                | scale fleet (queue supports it)                    |
| Queue            | PG `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY` wired                                                        | 1k → 1M            | partition; impl-swap seam                          |
| DB               | one primary, separate per-process pools                                                                    | 100 → 1k → 1M      | pooler → replicas → partition → shard              |
| SSE / fan-out    | `NOTIFY`-wake per stream (1s poll gone)                                                                    | 1k                 | event-bus edge plane at high stream count          |
| Type sharing     | Zod→JSON-Schema gated; run-detail codegen'd; residual hand-mirror                                          | now (correctness)  | extend FE gen beyond run-detail (§2)               |
| Tenant isolation | Postgres RLS (denies by default) + org-scoped client                                                       | done               | RLS enforced; sharding follows at 1M               |
| Proof of port    | ~21 conformance seams + Stryker (floor 42%) + JSON-Schema export                                           | before rewrite     | conformance for last un-seamed surfaces + fixtures |
