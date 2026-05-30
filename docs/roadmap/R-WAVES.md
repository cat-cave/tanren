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

### R3a — convert the residual tenant-table sites (inert, conversion complete for request paths)

- [x] **R3a — the cohort-4-flagged residuals + every other REQUEST-reachable
      tenant-table site.** The three residuals cohort-4 left on the pool now
      carry org context: - **Forge READ-tool dispatcher** (`engine/forge/tools/read.ts` +
      `authz.ts` + `repo.ts`): every `deps.pool.query` over
      specs/runs/tasks/events/cost_records/personas/projects, plus the
      `assert{Project,Run,Spec}Access` gates (widened to `QueryClient`), now
      route through `resolveQueryClient(deps.pool)`. The `/forge/tools` route
      opens a `runWithOrgScope` (org = path org) around the dispatch; the
      `ask`/`proposals` dispatchers already ran inside a scope, so the resolver
      picks up that ambient client for free. - **Forge WRITE-tool dispatcher** (`engine/forge/tools/write.ts`): the
      `tanrenRerunTask` runs/tasks lookup + the `tanrenCreateSpec` behavior /
      milestone links + the `acknowledge_insight` write route through
      `resolveQueryClient`/`resolveWritableClient`. `createSpec` /
      `createQueuedRunFromSpec` keep opening their OWN org-scoped txn from the
      actor's org (R1/cohort-3) — they read already-committed rows, so the
      nested scope is safe. - **`engine/recovery`'s `openInspectionThread`** (the named residual that
      wrote a `forge_threads` row UNSCOPED): now runs the thread create + the
      lineage-event append in ONE `runWithOrgScope` (org from the route's path
      param). `reviseSpec`/`replanWithSteering`/`rollbackToCommit` likewise
      scope their event appends + spec-prep UPDATEs; the spec-prep UPDATEs run
      in their own short scope so they COMMIT before the nested
      `createQueuedRunFromSpec` claims the now-`pending` spec (wrapping the
      whole action in one outer txn would hide the UPDATE from the nested claim
      and break replan). The recovery-route gate (`assertRunAccess` +
      `loadHaltedRunContext`) runs inside one org scope. - **The narration insights-cache read** (`routes/forge/narration.ts`): the
      generators no longer take `pool`; `loadNarrationInsights` runs on the
      ambient org-scoped `client`, so the insights compute reads
      (runs/events/specs/tasks/cost_records) AND the `workflow_insights` cache
      read/write carry org context.

      Proof: `tests/rlsR3aResidualSites.integration.test.ts` (real PG, run via
      `just smoke-rls-r3a`) — the forge read dispatch returns the org's rows on
      the scoped client identical to the pool, same-transaction writes are
      visible (proving the ambient client was used), `openInspectionThread`
      stamps `forge_threads.org_id`, and the conversion is INERT (with no
      policies, an org-A scope still reads org-B's run — exactly the pool's
      pre-R3a behavior). The forge tool / authz / write-approval / conversation /
      narration / insights-cache / recovery-route unit tests stayed unchanged (no
      observable behavior changed; the `ForgeMemoryClient`/fake pools are returned
      verbatim by the resolver since no ambient scope is open in those tests).

**Every REQUEST-reachable tenant-table query now carries org context by
construction.** The one surface still on the raw pool is the **worker per-job
WORKFLOW execution** — see the audit table below — which is its own cohort
(R3a-worker) because it CANNOT be wrapped in a single `runWithOrgScope`: the
workflow interleaves DB writes with minutes of external I/O (allocate, clone,
bootstrap, CI polling), so one transaction would hold a connection idle across
that whole span. It needs per-step short scopes (orgId is already resolved in
the worker as `resolvedOrgId`), and the workflow stores
(`PgEventStore`/`CostRecorder`/task helpers) already self-route via
`resolveWritableClient` — they only need an ambient scope established around each
DB-touching step. **R3b (policy enable + role flip) is gated on BOTH this PR
(request paths) AND the R3a-worker cohort** — see the fork note at the end.

### Full R3a audit — every tenant-table query site → its scope

Tenant tables = the `org_id`-bearing set in `db/src/schema*.ts`:
`runs, tasks, cost_records, events, runners, org_members, personas, audit_jobs,
projects, specs, forge_threads, forge_turns, forge_action_proposals,
inbox_sources, candidates, notification_targets, org_quotas`. (The R3b policy
list also covers FK-scoped tables with no own `org_id` —
`organizations, users, behaviors, milestones, spec_*, project_members,
workflow_insights, notification_routes` — scoped via their parent's `org_id`.)

| Site                                                                                                                          | Tenant table(s)                                                       | Scope / disposition                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/runs/{index,list,sse}.ts`                                                                                             | runs, tasks, events, cost_records, specs                              | **request** — wrapped in `runWithOrgScope` (R2 cohort-1/2/4)                                                                                                                    |
| `routes/specs/index.ts`                                                                                                       | specs                                                                 | **request** — `runWithOrgScope` (R2 cohort-3)                                                                                                                                   |
| `engine/eventStore.ts`                                                                                                        | events                                                                | **request/per-job** — `resolveWritableClient` (R2 cohort-1)                                                                                                                     |
| `engine/workflow/subtaskTasks.ts`                                                                                             | tasks                                                                 | **per-job** — `resolveWritableClient` (R2 cohort-2)                                                                                                                             |
| `engine/costs/recorder.ts`                                                                                                    | cost_records                                                          | **per-job** — `resolveWritableClient` (R2 cohort-2)                                                                                                                             |
| `engine/repositories/{runs,tasks,specs,actors}.ts`                                                                            | runs, tasks, specs                                                    | DAL-shaped (`QueryClient` param); scoped by caller (R2)                                                                                                                         |
| `engine/allocators/runnerStore.ts`                                                                                            | runners                                                               | **per-job** — `resolveWritableClient` (R2 cohort-3)                                                                                                                             |
| `engine/quota/dbPolicy.ts`                                                                                                    | org_quotas                                                            | **per-job** — `resolveWritableClient` + worker scope (R2 cohort-3)                                                                                                              |
| `engine/worker/runExecutor.ts` (finalizers + `establishJobOrgContext`)                                                        | runs, events                                                          | **per-job** — `runWithOrgScope` (R2 cohort-3)                                                                                                                                   |
| `engine/forge/{threads,turns,proposals}.ts`                                                                                   | forge_threads/turns/proposals                                         | **request** — `resolveWritableClient` (R2 cohort-4)                                                                                                                             |
| `routes/forge/narration.ts`                                                                                                   | runs, tasks, cost_records, projects                                   | **request** — scoped `client` (R2 cohort-4); insights-cache now on `client` (**R3a**)                                                                                           |
| `engine/forge/tools/{read,authz,repo}.ts`                                                                                     | specs, runs, tasks, events, cost_records, personas, projects          | **request** — `resolveQueryClient`; `/forge/tools` + ask scope (**R3a**)                                                                                                        |
| `engine/forge/tools/write.ts`                                                                                                 | runs, tasks (+ behavior/milestone links)                              | **request** — `resolveQueryClient`/`resolveWritableClient`; create paths self-scope (**R3a**)                                                                                   |
| `engine/recovery/index.ts`                                                                                                    | runs, events, specs, forge_threads                                    | **request** — `runWithOrgScope` per step (**R3a**)                                                                                                                              |
| `engine/insights/{computer,retryHotspot,modelMismatch,paceAnomaly,stuck,reviewStall,dora/compute}.ts`                         | runs, events, specs, tasks                                            | DAL-shaped (`QueryClient`); scoped when reached via the narration / forge-read path (**R3a**); the `routes/insights` + `routes/dora` entry is still pool — **R3+ route cohort** |
| `engine/workflow/{helloRun,helloRunSteps,plannerRun,ciPolling,ciWebhook,githubDraftPr,reviewMerge/*}.ts`                      | runs, tasks, specs, projects                                          | **per-job WORKFLOW** — still pool — **R3a-worker cohort** (fork; cannot be one txn)                                                                                             |
| `engine/worker/{runExecutionContext,jobReaper}.ts`                                                                            | runs, projects, specs                                                 | **per-job** read/sweep — still pool — **R3a-worker cohort**                                                                                                                     |
| `engine/workflow/projectSpec.ts` `createProject` + `ensureProject*` helpers                                                   | projects, specs                                                       | `createProject` is cross-org admin **system** seeding; the `ensure*` read helpers run inside the self-scoped create txn — R3+ tidy                                              |
| `engine/workflow/phase1Fixture.ts`                                                                                            | runs, specs, tasks                                                    | **system** — Phase-1 seed fixture (cross-org dev seeding), `runWithSystemScope` when wired                                                                                      |
| `engine/quota/meteringExport.ts`                                                                                              | cost_records                                                          | DAL-shaped (`QueryClient`); no live caller yet — R3+ when the hosting-export call site lands                                                                                    |
| `engine/forge/inbox/store.ts`, `engine/forge/audits/store.ts`, `engine/entities/personas.ts`, `engine/notifications/store.ts` | inbox_sources, candidates, audit_jobs, personas, notification_targets | DAL-shaped (`client` param); their **routes** (`inbox`/`audits`/`personas`/`notifications`) are still pool — **R3+ route cohort**                                               |
| `routes/{projects,brownfield,orgs}.ts`                                                                                        | projects, org_members                                                 | **request** reads — still pool — **R3+ route cohort** (listed in R3+)                                                                                                           |
| `auth/identityStore.ts`                                                                                                       | org_members, projects                                                 | **identity/login** — resolves a user's org BEFORE any org context exists; **system / pre-org** by nature — R3+ auth surface                                                     |
| `main.ts` `GET /runs/:runId` (legacy internal)                                                                                | runs, tasks, events, cost_records                                     | legacy un-org'd debug route (no `:orgId`); **R3+** (needs an org lookup to scope)                                                                                               |
| `engine/contracts/jobQueue.ts`, `engine/repositories/jobs.ts`                                                                 | job_queue                                                             | **system** — `job_queue` stays OUTSIDE RLS (locked decision); claim runs under `runWithSystemScope`                                                                             |

The only remaining R2 strand is **R3b** below (enable RLS policies + flip the
runtime role to `tanren_app` + the two-org isolation test).

Fallback semantics (all cohorts): with no ambient scope (startup, cross-org
system ops) the resolver falls back to the pool so behavior is unchanged. The
worker's failure-path finalizers no longer rely on that fallback when the run's
org is known (cohort-3 establishes a scope there); they fall back to the pool
only for a legacy/unscoped run. **R3 will tighten this** — once policies are on,
the fallback for tenant tables must become an error, not a silent pool query.
The app-layer `WHERE org_id = $n` filters stay (belt-and-suspenders) regardless.

### R3b — policy enablement + role flip (after the DAL conversion)

**Fork / precondition.** R3b enables policies on the runtime role (`tanren_app`,
non-bypass-RLS). Once a policy bites, a tenant query that runs on the raw pool
(empty `app.current_org_id` GUC) returns ZERO rows / is denied. So R3b is safe
**only after BOTH** (1) this PR — every request-reachable tenant query carries
context — **and** (2) the **R3a-worker cohort**: the per-job WORKFLOW execution
(`engine/workflow/**` + `engine/worker/{runExecutionContext,jobReaper}.ts`) still
runs on the raw pool, and the worker writes most tenant rows (runs/tasks/specs/
events status transitions). Enabling policies before that cohort would break the
worker. The worker already resolves `resolvedOrgId` per job; the conversion is to
establish a short org scope around each DB-touching workflow step (NOT one
transaction spanning the run's external I/O). Until R3a-worker lands, R3b must
stay off.

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
