# SaaS multi-tenancy: RLS + control-plane/data-plane split — plan

**Status: IN PROGRESS.** Refactor 1 (RLS) is **DONE and FULLY ENFORCED** (waves
R1 → R3b; migration `0030`). Refactor 2 (plane split) is **at P3a: the
run-executor worker is a STANDALONE deployable (P1) that claims over an
authenticated mTLS control-plane endpoint (P2 — `POST /internal/claim-job`), and
can now route its run-state WRITES (event-append, cost-record insert, run
finalize) through control-plane `/internal/*` write endpoints over the same mTLS
channel (P3a — the `RunStateWriter` seam behind `TANREN_DATA_PLANE_REMOTE_WRITES=1`,
default-direct + reversible, exactly-once preserved)**; **P3b (flip the default +
DROP the data-plane tenant-table write grants + per-run scoped creds / Vault
de-privilege) is OUTSTANDING.** The live conversion checklist is
`docs/roadmap/R-WAVES.md` (RLS R-waves + plane-split P-waves). These are the two
big multi-tenant refactors deliberately deferred from the expansion work.

This follows the **open-source / hosting-available** model: the isolation and
plane primitives that make a hosted product _deployable_ live in this repo; the
commercial layer (billing, pricing, plan tiers, marketing) does **not**. This
plan covers only the former.

## Where we already are (build on these, don't duplicate)

- **`org_id` is mandatory** on the core tables (migration `0026`: runs, tasks,
  events, cost_records, specs, runners — NOT NULL + FK + composite indexes).
- **`ActorContext`** (userId, orgId, projectId, scopes) is fully typed; scope
  checks (`platform:admin` / `org:admin` / `org:member` / `project:*`) exist.
- **Isolation is enforced app-layer only.** ~269 query sites filter by `org_id`
  in application code; there is **no database-level enforcement**. A query that
  forgets `WHERE org_id = $n` returns cross-tenant rows silently. This is the
  gap RLS closes.
- **Seams already in place:** `QuotaPolicy` (noop default / DB-backed) + metering
  export; tenant-namespaced credential refs (`credential/<slug>/<scope>/<owner>/<name>`);
  `providerMode: byok|managed`; pluggable secret-store factory.
- **Already-separate processes:** the allocator is its own service (static bearer
  token); the dashboard is a BFF with **no direct DB access**; the run worker is
  flag-gated (`TANREN_RUN_WORKER=1`) but runs **in-process** in the orchestrator,
  sharing its `pg.Pool` and in-process caches (e.g. `GithubAppTokenMinter`).
- **Job queue** is Postgres-native (`FOR UPDATE SKIP LOCKED` atomic claim).

## The two refactors and why

1. **RLS (Row-Level Security)** — _defense in depth._ Today a single forgotten
   filter leaks tenants. RLS makes Postgres itself enforce `org_id` isolation, so
   a query bug can't cross tenants. The app-layer filters stay (belt **and**
   suspenders); RLS is the backstop.
2. **Control-plane / data-plane split** — _blast radius + scaling._ The data
   plane executes agent CLIs against workspaces (semi-trusted code). Today that
   worker shares the orchestrator's superuser DB pool and Vault access. Splitting
   it means a compromised runner can't reach the control DB or root secrets, and
   the two halves scale independently.

---

## Refactor 1 — RLS

**Blockers (from the terrain map):** one shared `pg.Pool` with no per-request
context (setting a session var on a pooled connection bleeds across concurrent
requests); ~269 scattered query sites with no central data-access layer; runtime
connects as a privileged role (superuser **bypasses** RLS).

**Approach**

- **Per-request org context.** Check out a connection per request, run the
  request's queries inside a transaction with `SET LOCAL app.current_org_id =
$org` (transaction-scoped → no bleed), release on completion. Alternative:
  pgBouncer in transaction mode + `SET LOCAL`. (Decision below.)
- **Restricted runtime role.** Migrations run as the table owner; the runtime
  connects as a non-owner role that RLS actually applies to. Superuser/owner
  bypasses policies, so this separation is mandatory for RLS to mean anything.
- **Policies** on every tenant-scoped table (the `0026` six + projects,
  forge_threads/turns, org_quotas, credentials metadata, …):
  `USING (org_id = current_setting('app.current_org_id')::text)`.
- **Keep app-layer filters.** RLS is the backstop, not a license to drop the
  explicit `WHERE org_id`. Both layers stay.
- **Worker / cross-org operations.** The job-queue claim and other system-level
  operations are intentionally cross-org; they run under a **system context**
  (bypass role or queue tables left outside RLS), then the worker derives the
  claimed job's `org_id` and sets the per-job context for that run's queries.

**Waves** (each flag-gated, independently shippable, reversible)

- **R1 — plumbing, no policies.** Add the restricted runtime role + per-request
  transaction/session-context. Behavior unchanged (no policies yet); this is the
  riskiest infra change, landed in isolation so it can be proven inert.
- **R2 — policies, table-by-table, behind a flag.** Enable RLS + policy per
  table with a **two-org isolation test** (org A's session sees zero of org B's
  rows at the DB level) gating each.
- **R3 — worker/job context + enforce.** Wire the per-job context in the worker,
  flip enforcement on everywhere, keep app filters.

**Risks:** connection-checkout latency under load; pool sizing; the worker's
legitimately-cross-org reads; getting the migrations-as-owner vs runtime-role
split right; `current_setting` typing/escaping.

---

## Refactor 2 — control-plane / data-plane split

**Current:** monolith. Worker in-process (the `TANREN_RUN_WORKER` flag already
marks the seam) sharing the pool + caches; allocator already separate; dashboard
already a DB-less BFF. So the seam to formalize is **orchestrator API (control)
↔ run executor + runner substrate (data)**.

**Target planes**

- **Control plane** — HTTP API, auth, all state mutations, job enqueue, quota
  admission, review/merge orchestration, credential-resolution _policy_, token
  minting. Trusted; holds Postgres + Vault access.
- **Data plane** — the run executor + runner substrate. Executes agent CLIs on
  workspaces. Should hold **no** broad DB credentials and **no** Vault root —
  only short-lived, per-run, scoped material.

**Approach**

- **Extract the worker** into its own deployable (the flag already isolates it).
  Instead of claiming from `job_queue` with a superuser connection, it pulls work
  from the control plane and reports events/results **back over an authenticated
  channel** (mTLS or signed service JWT) — shrinking the data plane's direct DB
  surface toward zero.
- **Scoped credentials.** The control plane mints short-lived per-run credentials
  for the data plane (it already mints GitHub App installation tokens — extend
  that model) rather than handing over Vault refs/root.
- **Move in-process caches** (`GithubAppTokenMinter`) to the control plane; the
  data plane receives already-minted tokens.

**Waves** (tracked in `docs/roadmap/R-WAVES.md` → "Plane-split P-waves")

- **P1 — process boundary. DONE.** The worker is a standalone deployable: a
  dedicated entrypoint (`services/orchestrator/src/worker-main.ts` →
  `bootRunWorker`, reusing the existing `RunWorker`) and a `worker` compose
  service (dev + prod), still same DB + same `job_queue` DB-CAS claim. The API no
  longer runs the worker in-process by default (`TANREN_RUN_WORKER=1` kept for
  single-process dev/test). Pure deployment-topology change, **no trust change**.
  Proven cross-process by `just smoke-plane-split-worker`.
- **P2 — service identity + control-plane CLAIM endpoint. DONE.** A mutual-TLS
  (locked decision #3) internal channel between control and data planes — a
  contract-shaped transport seam (`MtlsFetch` / `MtlsPeerVerifier`), dev certs by
  `just gen-mtls-certs` + env, prod cert paths via the same env. The job-claim
  moved off direct DB-CAS to an authenticated `POST /internal/claim-job` endpoint
  on a separate internal mTLS listener: it authn's the mTLS peer FIRST, then runs
  the SAME atomic claim (`FOR UPDATE SKIP LOCKED`) and returns the job + its
  `org_id`. The cross-process `worker` claims over the endpoint (the in-process
  dev path keeps the direct DB-CAS). **Exactly-once preserved** — the endpoint
  wraps the same `claim()`; no migration. The data plane no longer needs direct
  `job_queue` write access to claim in the cross-process topology (full
  de-privilege is P3). Proven by `tests/internalClaimEndpoint.test.ts` (authn
  reject + claim-once-under-contention) + the mTLS-extended
  `smoke-plane-split-worker`.
- **P3a — control-plane WRITE endpoints + the `RunStateWriter` seam. DONE
  (flagged).** The worker's run-state WRITES — event-append, cost-record insert,
  run finalize (`failed`/`halted`/`done`) — can now route through control-plane
  `/internal/{append-event,record-cost,finalize-run}` endpoints over the SAME P2
  mTLS channel: each authn's the peer FIRST, then performs the SAME org-scoped
  write server-side (reusing `PgEventStore`/`CostRecorder` under
  `runWithOrgScope`), so a compromised runner can't write the control DB. A
  `RunStateWriter` seam (`DirectRunStateWriter` in-process — the DEFAULT — vs
  `HttpRunStateWriter` remote) picks via `TANREN_DATA_PLANE_REMOTE_WRITES=1`;
  **DIRECT stays the default so P3a is REVERSIBLE** and behavior-identical
  (exactly-once preserved — the finalize endpoint applies the same guard). Proven
  by `tests/planeSplitP3RemoteWrites.integration.test.ts` (real PG, enforced RLS)
  - the remote-writes-extended `smoke-plane-split-worker`.
- **P3b — flip the default + DROP the data-plane write grants / Vault.
  OUTSTANDING.** Flip remote-writes on by default + drop the tenant-table
  `INSERT`/`UPDATE` grants from a write-NONE data-plane DB role (a future
  migration); per-run scoped credentials (move the `GithubAppTokenMinter` cache
  to the control plane); remove Vault root / broad secret access from the data
  plane entirely.

**Risks:** moving job-claim atomicity from DB `SKIP LOCKED` to an API (need to
preserve exactly-once claim); event throughput/latency vs the current direct
writes; backpressure; the allocator's place in the new topology.

---

## Sequencing

**RLS first (R1–R3), then the plane split (P1–P3).** RLS delivers the
per-request org-context plumbing and the restricted runtime role that the plane
split's de-privileged data plane builds on. Every wave is flag-gated,
independently shippable, reversible, and goes per-PR-through-CI. RLS infra (R1)
is the single highest-risk change and is deliberately landed inert and first.

## Open decisions (need your call before R1/P1)

1. **RLS session-var mechanism:** app-managed per-request connection checkout vs
   **pgBouncer in transaction mode**. (Affects deploy topology + perf.)
2. **Cross-org system ops:** a dedicated bypass role vs leaving `job_queue` (and
   other system tables) outside RLS.
3. **Control↔data transport:** mTLS vs signed service JWT.
4. **Data-plane de-privileging depth now:** RESOLVED — P1 (separate process,
   same DB) + P2 (mTLS + control-plane claim endpoint) are DONE; P3 (route the
   worker's WRITES through the control plane + per-run scoped credentials) lands
   as a later wave.
5. **Hosting topology:** one Postgres with RLS (cheaper, simpler) vs separate
   databases per plane/tenant tier (stronger isolation, more ops).

## Non-goals / out of repo

Billing, metering-to-invoice, pricing, plan tiers, entitlement marketing — all
out. This plan covers only the isolation + plane primitives that make a hosted
deployment possible; the `QuotaPolicy` + metering-export seams are the boundary
where an out-of-repo commercial layer plugs in.
