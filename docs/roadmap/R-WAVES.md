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
- [x] **Cohort-2 — tasks + cost_records.** `tasks` **writes**
      (`subtaskTasks.ts`: `insertPlannerTask` / `insertChildTask` /
      `markTaskDone`, the INSERT path `subtaskStages.ts` drives) now route through
      the org-scoped client when handed the pool, falling back to it when no scope
      is open; handed a specific client they use it verbatim — so the
      mutation-hardened `subtaskStages.test.ts` stays behavior-identical (its bare
      query-only stub is used verbatim). `cost_records` **reads**: the costs page
      (`fetchCostsPage`, widened to `QueryClient`, handler wrapped in
      `runWithOrgScope`), the snapshot (`fetchRunCostsForSnapshot`, already a
      `QueryClient` — wrapped by cohort-1), and the SSE cost deltas
      (`pollNewCosts`, already on cohort-1's per-tick org-scoped txn).
      `cost_records` **writes**: `CostRecorder.record` + `reconcile*`/
      `apportionRunCost` route through the same pool-or-scope seam. Metering read:
      the post-run accrual `getRunUsage` runs in its own short org-scoped txn; the
      hosting-export reads (`getOrgUsage` / `streamBillableRuns`) already accept a
      `QueryClient` (no live caller yet to wrap). The shared write-path
      discriminator now lives in `engine/data/orgScopedDb.ts` as
      `resolveWritableClient` (pool → ambient/fallback; specific client → verbatim;
      `eventStore` refactored onto it). Proof:
      `tests/rlsR2DalTasksCosts.integration.test.ts` (real PG, `just
smoke-rls-r2-cohort2`) + `tests/rlsR2WriteRouting.test.ts` routing/fallback
      cases. Excluded (cohort-3 / R3): the worker **failure-path finalizers**
      (`finalizeRunRecoverable` / `finalizeRunQuotaExceeded`) — no ambient scope
      there yet.
- [x] **Cohort-3 — specs + runners + quota + the worker failure-path
      finalizers.** specs **reads** (`routes/specs/index.ts` list/detail wrapped
      in `runWithOrgScope`; `SpecStore.get/list` already `QueryClient`-shaped) +
      **writes** (`routes/specs/index.ts` PATCH UPDATE wrapped; the engine
      `createSpec` runs its pre-checks + INSERT through the org-scoped client when
      the actor carries an org, else the pool — mirroring
      `createQueuedRunFromSpec`; its `ensureProject*` helpers widened to
      `QueryClient`). runner-metadata **writes** (`PgRunnerStore.claim` /
      `.release`, handed the pool) route through the ambient org-scoped client via
      `resolveWritableClient`, falling back to the pool when no scope is open.
      `org_quotas` **read + write** (`DbQuotaPolicy.checkAdmission`'s `loadRow`
      SELECT + `accrueUsage`'s UPDATE) route through `resolveWritableClient`; the
      worker now runs the admission gate AND the post-run accrual (the
      `cost_records` read + `accrueUsage` together) inside short org-scoped
      transactions so both carry org context. The worker **failure-path
      finalizers** (`runExecutor.ts`: `finalizeRunRecoverable` /
      `finalizeRunQuotaExceeded`), flagged deferred in cohort-1/2, now establish a
      scope: each takes the run's org (resolved from its execution context — the
      success path's `orgId`, hoisted so the catch path has it) and runs its
      finalize UPDATE + best-effort event append in ONE `runWithOrgScope`
      transaction; a legacy/unscoped run (org_id NULL) — or a context load that
      itself threw — falls back to the pool (the pre-cohort-3 behavior). Proof:
      `tests/rlsR2DalSpecsRunnersQuota.integration.test.ts` (real PG, run via
      `just smoke-rls-r2-cohort3`); the existing `quotaPolicy` /
      `quotaAdmissionGate` / `runnerStore` / `runWorker` / `projectSpecWorkflow`
      tests stayed unchanged.
- [x] **Cohort-4 (FINAL) — forge.** The three forge tenant tables —
      `forge_threads`, `forge_turns`, `forge_action_proposals` — now route
      through the org-scoped client. The stores (`ForgeThreadStore`,
      `ForgeTurnStore`, `ForgeProposalStore`) resolve every read/write through
      `resolveWritableClient` (handed the pool → ambient scope when one is open,
      else the pool; handed a specific client → verbatim), so EVERY caller —
      including `engine/recovery`'s pool-handed `create`, an R3+ surface — gets
      the inert fallback. The forge routes establish the scope: `routes/forge`
      (thread create/get, turns list, the two narration generators —
      `generateProjectViewTurn`/`generateRunDetailTurn`, whose project/run/cost
      reads + forge_turn append now run in one org-scoped txn; the insights-cache
      read stays on the pool, an R3+ surface), `routes/forge/ask` (`askForge` —
      operator+forge turns + proposal persistence in one scoped txn; the
      read-tool dispatcher stays pool-bound, R3+), and `routes/forge/proposals`
      (`listForThread` + `decideForgeProposal` — claim/recordOutcome/turn append
      in one scoped txn; the write-tool dispatcher stays pool-bound, R3+). The
      run-detail **Forge bundle** (`routes/runs/index.ts` `fetchForgeBundle`),
      left cross-store on the pool by cohort-1, now opens its own org-scoped txn
      for the `listForRun` + turns read. The `POST /forge/tools` dispatch stays
      on the pool (its spec/run/etc. tool reads + writes are an R3+ surface).
      Test-fake note: the unit tests pass a `ForgeMemoryClient` (no `connect()`)
      verbatim to the stores — `resolveWritableClient` returns it as-is (no
      ambient scope), so no test fake needed adapting and no observable behavior
      changed. Proof: `tests/rlsR2DalForge.integration.test.ts` (real PG, run via
      `just smoke-rls-r2-cohort4`); the forge unit tests (`forgeThreadsAndTurns`,
      `forgeWriteActionApproval`, `forgeConversation`, `forgeProposalStore`) and
      the specDiscovery/candidateInbox tests stayed unchanged.

**All conversion cohorts are now complete.** Every tenant table carries org
context by construction. The only remaining R2 strand is **R3** below (enable
RLS policies + flip the runtime role to `tanren_app` + the two-org isolation
test) — it is now UNBLOCKED.

Fallback semantics (all cohorts): with no ambient scope (startup, cross-org
system ops) the resolver falls back to the pool so behavior is unchanged. The
worker's failure-path finalizers no longer rely on that fallback when the run's
org is known (cohort-3 establishes a scope there); they fall back to the pool
only for a legacy/unscoped run. **R3 will tighten this** — once policies are on,
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

- [x] `routes/specs` — list/detail reads + the PATCH write + the engine
      `createSpec` path converted (R2 cohort-3). Still pending:
      `routes/projects`, `routes/personas`, `routes/behaviors`,
      `routes/milestones`
- [ ] `routes/insights`, `routes/dora`, `routes/notifications` (`routes/costs` —
      the run-scoped costs page — converted in R2 cohort-2)
- [ ] `routes/recovery`, `routes/inbox`, `routes/audits`, `routes/discovery`,
      `routes/onboarding`
- [x] `routes/forge` (+ ask/proposals) — the forge-table reads/writes converted
      (R2 cohort-4); the `POST /forge/tools` dispatch + the ask/decide tool
      dispatchers (spec/run/etc. reads + writes) remain pool-bound, R3+. Still
      pending: `routes/brownfield`, `routes/orgs`
- [ ] `routes/runs` remaining surfaces — R2 cohort-1 converted the detail
      snapshot (R1), the run list, the events page, the activity feed, and the
      SSE run/task/event reads; cohort-2 converted the **costs page** + the
      **SSE cost deltas** (`cost_records`); cohort-4 converted the **Forge
      bundle** (`fetchForgeBundle`, cross-store).

### Orchestrator engine (write + read paths)

- [x] Event store (`engine/eventStore.ts`) — append routes through the ambient
      org-scoped client (R2 cohort-1). The worker failure-path **finalize
      updates** (`runExecutor.ts` `finalizeRunRecoverable` /
      `finalizeRunQuotaExceeded`) now establish an org scope from the run's org
      (R2 cohort-3) — they fall back to the pool only for a legacy/unscoped run.
- [x] Task/cost recording (`engine/workflow/subtaskTasks.ts` task INSERT/UPDATE,
      `engine/costs/recorder.ts` cost INSERT + reconcile, post-run metering
      `getRunUsage`) — route through the pool-or-scope seam (R2 cohort-2). The
      hosting-export reads (`getOrgUsage` / `streamBillableRuns`) already take a
      `QueryClient`; their live call site lands later.
- [x] Runner-metadata writes (`engine/allocators/runnerStore.ts`
      `PgRunnerStore.claim` / `.release`) — route through the pool-or-scope seam
      (R2 cohort-3); the allocator HTTP logic is untouched, only the DB writes.
- [x] Quota reads/accrual (`engine/quota/**`) — `DbQuotaPolicy.checkAdmission` +
      `accrueUsage` route through the pool-or-scope seam, and the worker runs the
      admission gate + post-run accrual inside org-scoped transactions (R2
      cohort-3). The metering-export reads (`getOrgUsage` / `streamBillableRuns`)
      already take a `QueryClient`; their live call site lands later.
- [ ] Credential-resolution reads (`engine/credentials/**`)
- [ ] Insights compute/cache (`engine/insights/**`)

### Dashboard + CLI

- [ ] Dashboard server read surfaces that query Postgres directly
- [ ] CLI paths that read Postgres directly

Each item is DONE when its queries run through the org-scoped client AND a
behavior test proves the rows it returns match the scope.
