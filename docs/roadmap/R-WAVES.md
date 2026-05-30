# RLS R-waves — conversion checklist

The live checklist for the Postgres RLS rollout. Companion to
`docs/roadmap/saas-rls-and-plane-split-plan.md` (mechanism + locked decisions).

RLS is delivered inert-first: R1 establishes the mechanism with **no policies**;
later waves enable policies and convert the remaining query sites so every tenant
query runs under `SET LOCAL app.current_org_id` before the policy that bites.

## R1 — mechanism + restricted role (DONE, inert)

- [x] Restricted runtime role `tanren_app` (migration 0029) — non-owner,
      non-superuser, non-bypass-RLS; SELECT/INSERT/UPDATE/DELETE + sequence
      grants; default privileges for future owner-created objects.
- [x] `runWithOrgScope` / `runWithSystemScope` / `getOrgScopedClient`
      (`db/src/orgScope.ts`, exported from `@tanren/db`).
- [x] Request middleware derives `requestOrgId` from `ActorContext`
      (`getRequestOrgId`).
- [x] Worker per-job context: claim cross-org (system), then
      `establishJobOrgContext` for the claimed job's org.
- [x] Reference conversion — `runs` read (GET detail loaders) + write
      (`createQueuedRunFromSpec`).
- [x] Behavior proof against real Postgres
      (`rlsR1SessionContext.integration.test.ts`, `just smoke-rls-r1`).
- [ ] (NOT in R1) policies, runtime-role flip.

## R2 — data-access-layer (DAL) conversion + enable policies + flip the role

R2 has two strands. **(1) The DAL conversion** routes every tenant-table query
site through R1's org-scoped client so it carries org context, **org-scoped by
construction** — this is the substance future-refactor move #1 calls the single
highest-leverage move, and the precondition for policies (a query NOT on the
scoped client sees an empty GUC and returns ZERO rows once R3 enables policies).
**(2) Policy enablement + role flip** lands after the DAL conversion is complete.
The conversion is done in bounded, reviewable **cohorts**, each inert and
behavior-preserving.

### DAL home

`engine/data/orgScopedDb.ts` — `resolveQueryClient(pool)` returns the ambient
`getOrgScopedClient()` if a scope is open, else the pool (the inert fallback).
This is the seam the future-refactor doc names `engine/data/**`; chosen over
retrofitting `engine/repositories/**` because the repositories layer is
write-path-only today and most converted sites are route read loaders — the
resolver is far lower-churn than re-homing every loader into a repository.
`engine/repositories/runs.ts` (`RunStore`) already takes a `client` param, so it
is already DAL-shaped (a caller inside `runWithOrgScope` passes the scoped
client) and needed no change.

### Conversion cohorts

- [x] **Cohort-1 — runs + events.** Read loaders (`routes/runs/list.ts`:
      `fetchRunSummary`, `fetchRunTasks`, `fetchRunListItems`, `fetchEventsPage`,
      `fetchFeedPage`, `fetchRunEventsForSnapshot`) + `routes/runs/index.ts`
      handlers (list / detail / events page / feed) + `routes/runs/sse.ts`
      (snapshot + per-tick run/task/event/cost reads, each in its own short
      org-scoped txn) now run through the org-scoped client. The events **write**
      recorder `PgEventStore` (handed the pool) routes its INSERT through the
      ambient scoped client when a scope is open, falling back to the pool when
      none; handed a specific in-transaction client it uses it verbatim. Proof:
      `tests/rlsR2DalRunsEvents.integration.test.ts` (real PG, `just smoke-rls-r2`) + `tests/eventStore.test.ts` routing/fallback cases.
- [ ] **Cohort-2 — tasks + cost_records.** `tasks` writes (`subtaskStages.ts`,
      just hardened by #147/#149) + `cost_records` read/write
      (`fetchCostsPage`, `fetchRunCostsForSnapshot`, SSE `pollNewCosts`, the
      usage/metering recorder).
- [ ] **Cohort-3 — specs / runners / forge / quota** and the remaining route +
      engine read paths (see the R3+ list below).

Fallback semantics (all cohorts): with no ambient scope (startup, cross-org
system ops, the worker's failure-path finalizers) the resolver falls back to the
pool so behavior is unchanged. **R3 will tighten this** — once policies are on,
the fallback for tenant tables must become an error, not a silent pool query.
The app-layer `WHERE org_id = $n` filters stay (belt-and-suspenders) regardless.

### Policy enablement + role flip (after the DAL conversion)

- [ ] `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` on the tenant
      tables, keyed off `current_setting('app.current_org_id', true)`:
      `organizations`, `projects`, `specs`, `runs`, `tasks`, `events`,
      `cost_records`, `runners`, `personas`, `behaviors`, `milestones`,
      `spec_behaviors`, `spec_milestones`, `spec_dependencies`, `org_members`,
      `project_members`, `forge_threads`, `forge_turns`,
      `forge_action_proposals`, `workflow_insights`, `notification_targets`,
      `notification_routes`, `inbox_sources`, `candidates`, `audit_jobs`,
      `org_quotas`.
- [ ] Keep OUTSIDE RLS (cross-org / identity / system): `job_queue`,
      `notifications`, `sessions`, `api_tokens`, `users`,
      `rate_limit_observations`.
- [ ] Flip the runtime DATABASE_URL to `tanren_app` (migrations stay on owner).
- [ ] Negative behavior tests: cross-org reads/writes are denied under policy.

## R3+ — convert the remaining ~268 query sites

Mechanical `pool → getOrgScopedClient()/runWithOrgScope` conversions (no SQL
changes), each with a behavior test. Grouped by surface:

### Orchestrator routes (read paths)

- [ ] `routes/specs`, `routes/projects`, `routes/personas`, `routes/behaviors`,
      `routes/milestones`
- [ ] `routes/insights`, `routes/dora`, `routes/costs`, `routes/notifications`
- [ ] `routes/recovery`, `routes/inbox`, `routes/audits`, `routes/discovery`,
      `routes/onboarding`
- [ ] `routes/forge` (+ ask/proposals), `routes/brownfield`, `routes/orgs`
- [ ] `routes/runs` remaining surfaces — R2 cohort-1 converted the detail
      snapshot (R1), the run list, the events page, the activity feed, and the
      SSE run/task/event reads. Still on the pool: the **costs page** +
      **SSE cost deltas** (cohort-2, `cost_records`) and the **Forge bundle**
      (cross-store, cohort-3).

### Orchestrator engine (write + read paths)

- [x] Event store (`engine/eventStore.ts`) — append routes through the ambient
      org-scoped client (R2 cohort-1). The worker failure-path **finalize
      updates** (`runExecutor.ts` `finalizeRunRecoverable` /
      `finalizeRunQuotaExceeded`) still use the pool fallback — they run with no
      ambient scope; R3 establishes one there.
- [ ] Task/cost recording (`engine/workflow/subtask*`, usage/metering)
- [ ] Credential-resolution reads (`engine/credentials/**`)
- [ ] Quota reads/accrual (`engine/quota/**`)
- [ ] Insights compute/cache (`engine/insights/**`)

### Dashboard + CLI

- [ ] Dashboard server read surfaces that query Postgres directly
- [ ] CLI paths that read Postgres directly

Each item is DONE when its queries run through the org-scoped client AND a
behavior test proves the rows it returns match the scope.
