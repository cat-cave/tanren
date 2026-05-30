# SaaS RLS + control-plane/data-plane split — plan

Status: **R1 building** (this PR). Postgres Row-Level Security multi-tenancy,
delivered in inert waves so each step is provably behavior-neutral before the
policy that bites.

## Locked decisions

These are the approved, locked decisions the build follows:

- **App-managed per-request connection checkout + `SET LOCAL app.current_org_id`
  inside a transaction** (NOT pgBouncer). The app checks out a `pg` client,
  opens a transaction, stamps the org GUC, runs the request's queries, commits.
  `SET LOCAL` scopes the GUC to the transaction so it never leaks to a later
  checkout of the same pooled connection.
- **Restricted runtime role.** Migrations run as the table **owner**; the runtime
  connects as a **non-owner, non-superuser** role. The owner and any superuser
  **BYPASS RLS**, so this split is mandatory for RLS to ever bite. R1 creates the
  role (`tanren_app`); the runtime DATABASE_URL points at it once the plane split
  lands (R2+).
- **`job_queue` and other genuinely cross-org system tables stay OUTSIDE RLS.**
  The worker claims under a narrow **system/bypass context** (no org GUC — the
  claim spans tenants), then sets the **claimed job's org** before any tenant
  work.
- **One Postgres + RLS.** No second database; tenancy is enforced in-engine by
  RLS, not by physical separation.

## Mechanism (R1, this PR)

The mechanism module is `db/src/orgScope.ts`, exported from `@tanren/db`:

- `runWithOrgScope(pool, orgId, work)` — checks out a client, `BEGIN`,
  `SET LOCAL app.current_org_id = '<orgId>'`, runs `work(client)` on an
  `AsyncLocalStorage` scope, `COMMIT` (or `ROLLBACK` on throw), always releases.
  The org id is validated against `^[A-Za-z0-9_:.-]+$` before interpolation (a
  GUC cannot be parameterized).
- `runWithSystemScope(pool, work)` — the cross-org variant: a transaction with
  **no** org GUC, for genuinely cross-tenant system work (the `job_queue` claim).
- `getOrgScopedClient()` / `getOrgScope()` — the ambient scoped client/org for
  handlers that have adopted the path, reached without prop-drilling.

**Inertness:** with **no policies** (R1), the only observable effect of the above
is the GUC being set inside a transaction that nothing reads. Every query returns
exactly what it did against the pool.

### Restricted role (migration 0029)

`db/migrations/0029_rls_r1_restricted_role.sql` (generated via the Drizzle custom
migration workflow — `drizzle-kit generate --custom`) creates `tanren_app`:

- `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, dev/CI default
  password `tanren_app` (prod rotates it out-of-band and supplies the secret via
  the runtime DATABASE_URL — the literal is not a prod credential).
- `GRANT USAGE ON SCHEMA public` (no `CREATE` — DDL stays owner-only).
- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` + `USAGE, SELECT ON ALL
SEQUENCES` so nothing is lost relative to the owner path.
- `ALTER DEFAULT PRIVILEGES FOR ROLE tanren` so future owner-created tables are
  auto-granted (no per-R-wave GRANT bookkeeping).

Idempotent: re-running the full migration set on an existing DB does not error.

### Runtime DATABASE_URL selection

R1 is inert, so both the orchestrator and worker still connect as the **owner**
(`DATABASE_URL`) — they `migrate()` and serve on one pool. The runtime split is
documented in `compose.dev.yml`: the intended runtime URL is
`postgres://tanren_app:<pw>@postgres:5432/tanren`. Flipping the runtime pool to
`tanren_app` (with migrations still on the owner URL) is the **R2 plane-split**
step, taken together with `ENABLE ROW LEVEL SECURITY` + policies so the change is
verified by the policy that bites.

## Reference conversions (R1, this PR)

The proven reference pattern, wired end-to-end:

- **Request middleware** (`services/orchestrator/src/middleware/auth.ts`):
  `bindActor` sets `requestOrgId` from the resolved `ActorContext` on every
  authenticated path, so the org the scoped client stamps always matches the
  authenticated actor. `getRequestOrgId(c)` exposes it.
- **`runs` read path** (`routes/runs/index.ts` GET run detail): the run / spec /
  tasks / events / costs loaders run through `runWithOrgScope` on the path org
  (already validated against the actor). Loader signatures widened to a
  `QueryClient` (`Pick<Pool|PoolClient,"query">`) so both the pool and the scoped
  client satisfy them.
- **`runs` write path** (`engine/workflow/projectSpec.ts`
  `createQueuedRunFromSpec`): when the actor carries an org, the run-create
  transaction runs through `runWithOrgScope`; a legacy/unscoped actor keeps the
  original manual-transaction path.
- **Worker per-job context** (`engine/worker/runExecutor.ts`): the `job_queue`
  claim is cross-org (system context). After the claimed job's org is resolved,
  `establishJobOrgContext` opens the per-job org scope and confirms the run is
  reachable under it.

## What R2 / R3 still must do

R1 converts **one** reference read+write path. The remaining ~268 query sites
(~208 in `services/orchestrator/src` across ~53 files, plus the dashboard/CLI
read surfaces) are **NOT** yet org-scoped. The honest, explicit remaining work:

**R2 — enable policies + flip the runtime role**

- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` on the tenant
  tables (`organizations`, `projects`, `specs`, `runs`, `tasks`, `events`,
  `cost_records`, `runners`, `personas`, `behaviors`, `milestones`,
  `spec_behaviors`, `spec_milestones`, `spec_dependencies`, `org_members`,
  `project_members`, `forge_threads`, `forge_turns`, `forge_action_proposals`,
  `workflow_insights`, `notification_targets`, `notification_routes`,
  `inbox_sources`, `candidates`, `audit_jobs`, `org_quotas`) keyed off
  `current_setting('app.current_org_id', true)`.
- Keep `job_queue`, `notifications`, `sessions`, `api_tokens`, `users`,
  `rate_limit_observations` OUTSIDE RLS (cross-org / identity / system tables).
- Flip the runtime DATABASE_URL to `tanren_app` (migrations stay on the owner).

**R3+ — convert the remaining query sites to the org-scoped client**, wave by
wave, so that once policies are on, every tenant query runs under the GUC:

- All other `routes/**` read paths (specs, projects, personas, behaviors,
  milestones, insights, dora, costs, notifications, recovery, inbox, audits,
  discovery, onboarding, forge, brownfield).
- The remaining `engine/**` write paths (event store, task/cost recording,
  workflow finalize, credential resolution reads, quota reads/accrual).
- The dashboard + CLI read surfaces that query Postgres directly.

Each R-wave is a mechanical `pool → getOrgScopedClient()/runWithOrgScope`
conversion plus a behavior test; none changes SQL. See `R-WAVES.md` for the live
checklist.
