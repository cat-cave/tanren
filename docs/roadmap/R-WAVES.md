# RLS R-waves — conversion checklist

The live checklist for the Postgres RLS rollout. Companion to
`docs/roadmap/saas-rls-and-plane-split-plan.md` (mechanism + locked decisions).

**Status: R1 → R2 (cohorts 1–4) → R3a → R3a-worker → R3b are all DONE. RLS is
FULLY ENFORCED** at the database — the runtime connects as the restricted
`tanren_app` role and Postgres policies enforce org isolation (migration `0030`;
see **R3b** for the enforcement flip + bypass call sites).

RLS was delivered inert-first: R1 established the mechanism with **no policies**;
later waves enabled policies + converted the query sites so every tenant query
runs under `SET LOCAL app.current_org_id` before the policy bites.

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
      `apportionRunCost` route through the same pool-or-scope seam; the post-run
      accrual `getRunUsage` runs in its own short org-scoped txn. The shared
      write-path discriminator now lives in `engine/data/orgScopedDb.ts` as
      `resolveWritableClient` (pool → ambient/fallback; specific client → verbatim;
      `eventStore` refactored onto it). Proof:
      `tests/rlsR2DalTasksCosts.integration.test.ts` (real PG, `just
smoke-rls-r2-cohort2`) + `tests/rlsR2WriteRouting.test.ts` routing/fallback
      cases. (The worker failure-path finalizers were deferred to cohort-3.)
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

### R3a-worker — per-step org scoping in the worker run-execution path (inert, FINAL conversion)

- [x] **R3a-worker — the per-job WORKFLOW execution now carries org context on
      EVERY tenant-table op.** The worker run path (`engine/worker/runExecutor.ts` + `runExecutionContext.ts` + `jobReaper.ts` and the `engine/workflow/**`
      stages it drives) wrote most tenant rows (tasks/events/cost_records/runs/
      specs/runners) with NO ambient org scope. It CANNOT be one `runWithOrgScope`
      — the loop interleaves DB writes with minutes of external I/O (allocate,
      clone, bootstrap, CI polling), so a single transaction would hold a
      connection idle across that whole span. Mechanism: - **Per-job ambient org-id** (`runWithJobOrgId` / `getJobOrgId`,
      `db/src/orgScope.ts`): a lightweight `AsyncLocalStorage<string>` holding
      ONLY the run's `orgId` — NOT a connection — set once around the workflow
      execution (`withJobOrg(orgId, () => runWorkflow(...))`). Safe to keep open
      across the run's I/O because it holds no connection. - **Per-op short transactions** (`orgScopingPool` / `withJobOrgScope`,
      `engine/data/orgScopedDb.ts`): the worker hands the workflow an
      `orgScopingPool(deps.pool)` as `input.pool`. Its `.query()` resolves, per
      op: (1) ambient connection scope open → that scoped client; (2) else a
      per-job org-id present → a SHORT `runWithOrgScope(pool, jobOrgId, op)`;
      (3) else → the bare pool (inert). So every workflow tenant-table op —
      direct `input.pool.query` AND the self-routing stores
      (`PgEventStore`/`CostRecorder`/`subtaskTasks`) constructed with that pool —
      opens its own short org-scoped txn; a connection is held only for the
      duration of ONE DB op, never across external I/O. `CostRecorder`'s
      reconcile (a tight SELECT+UPDATEs batch with no I/O between) runs through
      `withJobOrgScope` so it shares ONE short txn. - **Bootstrap reads stay system-scoped**: `loadRunExecutionContext` (the
      run⋈spec⋈project read that RESOLVES which org owns the job) and the
      reaper's `loadRunLineage` (a cross-org sweep) run under
      `runWithSystemScope` — they legitimately precede / span org context. Under
      R3b these two need the bypass-role / policy-carve-out decision (the locked
      item in the RLS plan); they are the only worker tenant reads that do. - The worker's failure-path finalizers + quota gate + post-run accrual
      already open explicit `runWithOrgScope` from the resolved org (R2
      cohort-3) — unchanged. The reaper's dead-letter event append now runs
      under the reaped run's per-job org-id so its `events` INSERT is scoped.

      Proof: `tests/rlsR3aWorkerScoping.integration.test.ts` (real PG, run via
      `just smoke-rls-r3a-worker`). It installs a TEMPORARY throwaway GUC-keyed
      policy on tasks/events/cost_records under the restricted `tanren_app` role
      (a stand-in for R3b), then drives the worker's ACTUAL store helpers handed
      `orgScopingPool` under `runWithJobOrgId`: every write LANDS (each op set the
      GUC → was org-scoped per-op), while the same helpers on the bare pool with
      NO job-org-id are REJECTED (empty GUC → the no-job-org fallback IS the
      unscoped pool path). The hardened run-loop (#107) and subtask-stage (#149)
      tests + all worker/workflow unit tests (`runWorker`, `jobReaper`,
      `subtaskStages`, `rlsR2WriteRouting`, `costsRecorder`, `plannerRun*`,
      `ciPolling`, `reviewMerge`) stayed behavior-identical — only the `jobReaper`
      test FAKE adapted (its lineage SELECT gained `org_id` + the path became
      transactional, so the fake gained `connect`/BEGIN-COMMIT handling); no
      observable assertion changed.

**Every REQUEST-reachable AND worker-reachable tenant-table query now carries
org context by construction.** No tenant-table op remains unscoped in any
request OR worker path. **R3b is now DONE** (migration `0030`): policies are
enforced on `tanren_app`, the `tanren_system` BYPASSRLS role serves the
cross-org bootstrap/seeding reads, and `loadRunExecutionContext` reads the org
off the `job_queue` row instead of an RLS-protected `runs` read. See the R3b
section below for the full bypass call-site list + the two-org isolation proof.

### Full R3a audit — every tenant-table query site → its scope

Tenant tables = the `org_id`-bearing set in `db/src/schema*.ts`:
`runs, tasks, cost_records, events, runners, org_members, personas, audit_jobs,
projects, specs, forge_threads, forge_turns, forge_action_proposals,
inbox_sources, candidates, notification_targets, org_quotas`. (The R3b policy
list also covers FK-scoped tables with no own `org_id` —
`organizations, users, behaviors, milestones, spec_*, project_members,
workflow_insights, notification_routes` — scoped via their parent's `org_id`.)

| Site                                                                                                                          | Tenant table(s)                                                       | Scope / disposition                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/runs/{index,list,sse}.ts`                                                                                             | runs, tasks, events, cost_records, specs                              | **request** — wrapped in `runWithOrgScope` (R2 cohort-1/2/4)                                                                                                                                                                                                                             |
| `routes/specs/index.ts`                                                                                                       | specs                                                                 | **request** — `runWithOrgScope` (R2 cohort-3)                                                                                                                                                                                                                                            |
| `engine/eventStore.ts`                                                                                                        | events                                                                | **request/per-job** — `resolveWritableClient` (R2 cohort-1)                                                                                                                                                                                                                              |
| `engine/workflow/subtaskTasks.ts`                                                                                             | tasks                                                                 | **per-job** — `resolveWritableClient` (R2 cohort-2)                                                                                                                                                                                                                                      |
| `engine/costs/recorder.ts`                                                                                                    | cost_records                                                          | **per-job** — `resolveWritableClient` (R2 cohort-2)                                                                                                                                                                                                                                      |
| `engine/repositories/{runs,tasks,specs,actors}.ts`                                                                            | runs, tasks, specs                                                    | DAL-shaped (`QueryClient` param); scoped by caller (R2)                                                                                                                                                                                                                                  |
| `engine/allocators/runnerStore.ts`                                                                                            | runners                                                               | **per-job** — `resolveWritableClient` (R2 cohort-3)                                                                                                                                                                                                                                      |
| `engine/quota/dbPolicy.ts`                                                                                                    | org_quotas                                                            | **per-job** — `resolveWritableClient` + worker scope (R2 cohort-3)                                                                                                                                                                                                                       |
| `engine/worker/runExecutor.ts` (finalizers + `establishJobOrgContext`)                                                        | runs, events                                                          | **per-job** — `runWithOrgScope` (R2 cohort-3)                                                                                                                                                                                                                                            |
| `engine/forge/{threads,turns,proposals}.ts`                                                                                   | forge_threads/turns/proposals                                         | **request** — `resolveWritableClient` (R2 cohort-4)                                                                                                                                                                                                                                      |
| `routes/forge/narration.ts`                                                                                                   | runs, tasks, cost_records, projects                                   | **request** — scoped `client` (R2 cohort-4); insights-cache now on `client` (**R3a**)                                                                                                                                                                                                    |
| `engine/forge/tools/{read,authz,repo}.ts`                                                                                     | specs, runs, tasks, events, cost_records, personas, projects          | **request** — `resolveQueryClient`; `/forge/tools` + ask scope (**R3a**)                                                                                                                                                                                                                 |
| `engine/forge/tools/write.ts`                                                                                                 | runs, tasks (+ behavior/milestone links)                              | **request** — `resolveQueryClient`/`resolveWritableClient`; create paths self-scope (**R3a**)                                                                                                                                                                                            |
| `engine/recovery/index.ts`                                                                                                    | runs, events, specs, forge_threads                                    | **request** — `runWithOrgScope` per step (**R3a**)                                                                                                                                                                                                                                       |
| `engine/insights/{computer,retryHotspot,modelMismatch,paceAnomaly,stuck,reviewStall,dora/compute}.ts`                         | runs, events, specs, tasks                                            | DAL-shaped (`QueryClient`); scoped when reached via the narration / forge-read path (**R3a**); the `routes/insights` + `routes/dora` entry is still pool — **R3+ route cohort**                                                                                                          |
| `engine/workflow/{plannerRun,subtaskLoop,subtaskStages,ciPolling,githubDraftPr,reviewMerge/*}.ts` (planner run path)          | runs, tasks, specs, projects, events, cost_records                    | **per-job WORKFLOW** — `orgScopingPool` + `runWithJobOrgId` (per-op short transactions) (**R3a-worker**)                                                                                                                                                                                 |
| `engine/worker/runExecutor.ts` (finalizers + `establishJobOrgContext` + job-org-id wrap)                                      | runs, events                                                          | **per-job** — `runWithOrgScope` (finalizers, cohort-3) + `runWithJobOrgId` around the workflow (**R3a-worker**); `loadRunExecutionContext` hydration under `runWithOrgScope(jobOrgId)` from the queue row's `org_id` (**R3b**), or `runWithSystemScope` BYPASS for a legacy null-org job |
| `engine/worker/jobReaper.ts`                                                                                                  | runs (lineage), events                                                | **per-job sweep** — `loadRunLineage` under `runWithSystemScope` (cross-org BYPASS, **R3b**); dead-letter event append under the run's `runWithJobOrgId` (**R3a-worker**)                                                                                                                 |
| `engine/workflow/{helloRun,helloRunSteps,phase1Fixture}.ts` (non-worker fixture paths)                                        | runs, tasks, specs                                                    | **system / dev fixture** — not on the per-job worker run path; `runWithSystemScope` when wired — R3+ tidy                                                                                                                                                                                |
| `engine/workflow/projectSpec.ts` `createProject` + `ensureProject*` helpers                                                   | projects, specs                                                       | `createProject` is cross-org admin **system** seeding; the `ensure*` read helpers run inside the self-scoped create txn — R3+ tidy                                                                                                                                                       |
| `engine/workflow/phase1Fixture.ts`                                                                                            | runs, specs, tasks                                                    | **system** — Phase-1 seed fixture (cross-org dev seeding), `runWithSystemScope` when wired                                                                                                                                                                                               |
| `engine/quota/meteringExport.ts`                                                                                              | cost_records                                                          | DAL-shaped (`QueryClient`); no live caller yet — R3+ when the hosting-export call site lands                                                                                                                                                                                             |
| `engine/forge/inbox/store.ts`, `engine/forge/audits/store.ts`, `engine/entities/personas.ts`, `engine/notifications/store.ts` | inbox_sources, candidates, audit_jobs, personas, notification_targets | DAL-shaped (`client` param); their **routes** (`inbox`/`audits`/`personas`/`notifications`) are still pool — **R3+ route cohort**                                                                                                                                                        |
| `routes/{projects,brownfield,orgs}.ts`                                                                                        | projects, org_members                                                 | **request** reads — still pool — **R3+ route cohort** (listed in R3+)                                                                                                                                                                                                                    |
| `auth/identityStore.ts`                                                                                                       | org_members, projects                                                 | **identity/login** — resolves a user's org BEFORE any org context exists; **system / pre-org** by nature — R3+ auth surface                                                                                                                                                              |
| `main.ts` `GET /runs/:runId` (legacy internal)                                                                                | runs, tasks, events, cost_records                                     | legacy un-org'd debug route (no `:orgId`); **R3+** (needs an org lookup to scope)                                                                                                                                                                                                        |
| `engine/contracts/jobQueue.ts`, `engine/repositories/jobs.ts`                                                                 | job_queue                                                             | **system** — `job_queue` stays OUTSIDE RLS; now carries `org_id` (**R3b**), stamped on enqueue + read on claim so the worker bootstraps the job's org from the queue row (no RLS-protected `runs` read); claim runs under `runWithSystemScope`                                           |

**R3b is DONE** — see the section below (enable RLS policies + flip the runtime
role to `tanren_app` + the two-org isolation test, all landed in migration `0030`).

Fallback semantics (all cohorts): with no ambient scope the resolver falls back
to the pool. Under R3b's enforced policies that pool is the restricted
`tanren_app` connection, so a tenant query with no scope now sees an empty GUC
and is **denied at the database** (deny-by-default) rather than silently reading —
the resolver fallback is no longer a leak. Genuinely cross-org system reads run
on the `tanren_system` BYPASS pool via `runWithSystemScope`. The app-layer
`WHERE org_id = $n` filters stay (belt-and-suspenders) regardless.

### R3b — policy enablement + role flip (DONE — RLS FULLY ENFORCED)

**R3 is complete: RLS is enforced at the database.** Migration `0030` enables
Row-Level Security + a deny-by-default policy on every tenant table, creates the
narrow BYPASSRLS `tanren_system` role, and adds `job_queue.org_id`; the runtime
`DATABASE_URL` now connects as the restricted `tanren_app` role (NOBYPASSRLS)
while migrations run as the owner (`MIGRATION_DATABASE_URL`) and
`runWithSystemScope` connects as `tanren_system` (`TANREN_SYSTEM_DATABASE_URL`).

**The two locked-decision bootstrap reads were resolved "both, scoped":**

- **`job_queue` org threading** — `job_queue` gains an `org_id` column (migration
  `0030`), backfilled from the owning run and set on enqueue
  (`createQueuedRunFromSpec`, `PgJobQueue.enqueue`, hello fixture). The worker's
  `loadRunExecutionContext` no longer does an RLS-protected `runs` read to find
  the org: `executeNextPlanJob` reads the claimed job's `org_id` off the queue
  row (job_queue stays OUTSIDE RLS) and runs the run⋈spec⋈project hydration under
  `runWithOrgScope(jobOrgId)`. The hot-path bootstrap tenant read is gone.

- **`tanren_system` BYPASSRLS role** — `runWithSystemScope` now connects via its
  OWN pool as `tanren_system` (NOSUPERUSER, BYPASSRLS), used by the genuinely
  cross-org system reads.

**The exact BYPASS (`runWithSystemScope` / `tanren_system`) call sites:**

1. **Reaper cross-org lineage sweep** — `engine/worker/jobReaper.ts`
   `loadRunLineage` (`SELECT … FROM runs` across ALL orgs to resolve a reaped
   run's lineage for the dead-letter event).
2. **Worker job-org bootstrap (legacy/null-org only)** —
   `engine/worker/runExecutor.ts` `loadRunContextScoped`: a job carrying an
   `org_id` hydrates under `runWithOrgScope`; only a legacy/unscoped job
   (`org_id` NULL) falls back to `runWithSystemScope`.
3. **Legacy debug route org resolve** — `main.ts` `GET /runs/:runId` (no
   `:orgId` path param) resolves the run's org via `runWithSystemScope`, then
   reads under `runWithOrgScope(org)`.
4. **Hello fixture (cross-org seeding)** — `runHelloWorkflow` runs on the
   `tanren_system` pool (`/hello/run` hands it `getSystemPool() ?? pool`), and
   its allocator's `PgRunnerStore` is built over the same system pool, so the
   synthetic fixture-org chain (organizations/projects/specs/runs/tasks/events/
   cost_records/runners) writes under bypass.
5. **`createProject` cross-org admin seeding** — `engine/workflow/projectSpec.ts`:
   an org-carrying actor persists under `runWithOrgScope`; a null-org caller
   (platform bootstrap) persists on the `tanren_system` pool.
6. **Allocator sidecar service** — `services/allocator/src/main.ts`: a cross-org
   system service; its runtime pool is `TANREN_SYSTEM_DATABASE_URL`.

(`phase1Fixture` is a live-only dev seed run as the owner role in its live test,
so it never hits the enforced policies; left as-is.)

- [x] `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `CREATE POLICY rls_org_isolation`
      (USING + WITH CHECK, `org_id = current_setting('app.current_org_id', true)`)
      on the tenant tables — direct-org_id: `organizations` (keyed on `id`),
      `projects`, `specs`, `runs`, `tasks`, `events`, `cost_records`, `runners`,
      `personas`, `org_members`, `forge_threads`, `forge_action_proposals`,
      `inbox_sources`, `candidates`, `notification_targets`, `audit_jobs`,
      `org_quotas`; FK-scoped (parent EXISTS subquery): `behaviors`, `milestones`,
      `spec_behaviors`, `spec_milestones`, `spec_dependencies`, `project_members`,
      `forge_turns`, `workflow_insights`, `notification_routes`.
- [x] Kept OUTSIDE RLS (cross-org / identity / system): `job_queue`,
      `notifications`, `sessions`, `api_tokens`, `users`,
      `rate_limit_observations`.
- [x] Flipped the runtime DATABASE_URL to `tanren_app` (compose dev + prod);
      migrations run as the owner (`MIGRATION_DATABASE_URL`); `runWithSystemScope`
      uses `TANREN_SYSTEM_DATABASE_URL` (`tanren_system`).
- [x] Two-org DB-level isolation test under `tanren_app`
      (`tests/rlsR3bEnforcement.integration.test.ts`, `just smoke-rls-r3b`):
      org A's scope sees ZERO of org B's rows AT THE DB, an unset GUC returns zero
      (deny-by-default), a WITH CHECK write for the wrong org is rejected, a
      correctly-scoped read/write is unchanged, the `tanren_system` bypass pool
      reads across orgs, and `job_queue` stays outside RLS. The R1/R2/R3a cohort
      tests were updated from "inert (pool == scoped)" to the enforcement reality
      (scoped works; raw pool is deny-by-default; unscoped writes are rejected).
- [x] Flipped-role smoke (`just smoke`): `smoke-hello` runs a real run + worker
      writes (org-scoped) + `tanren status` read-back end-to-end with the runtime
      as `tanren_app` and policies enabled.

## R3+ — convert the remaining ~268 query sites

Mechanical `pool → getOrgScopedClient()/runWithOrgScope` conversions (no SQL
changes), each with a behavior test, grouped by surface.

### Orchestrator routes (read paths)

- [x] `routes/specs`, `routes/forge` (+ ask/proposals), and `routes/runs`
      surfaces (detail snapshot, list, events page, feed, SSE, costs page, Forge
      bundle) converted (R2 cohorts 1–4; see those sections).
- [ ] Still pending: `routes/{projects,personas,behaviors,milestones,insights,
dora,notifications,recovery,inbox,audits,discovery,onboarding,brownfield,
orgs}` + the `POST /forge/tools` dispatch.

### Orchestrator engine (write + read paths)

- [x] Event store, task/cost recording, runner-metadata writes, quota
      reads/accrual + worker failure-path finalizers — all route through the
      pool-or-scope seam (R2 cohorts 1–3; see those sections). Hosting-export reads
      (`getOrgUsage` / `streamBillableRuns`) already take a `QueryClient`; their
      live call site lands later.
- [ ] Credential-resolution reads (`engine/credentials/**`), insights
      compute/cache (`engine/insights/**`), and dashboard/CLI surfaces that query
      Postgres directly.

Each item is DONE when its queries run through the org-scoped client AND a
behavior test proves the rows it returns match the scope.

---

# Plane-split P-waves — control-plane / data-plane checklist

Companion checklist for Refactor 2 in
`docs/roadmap/saas-rls-and-plane-split-plan.md` (plane-split section + locked
decisions: mTLS transport, push de-privileging to P3). Builds on the R3b
runtime-role split (data plane = restricted `tanren_app`; `tanren_system` BYPASS
serves cross-org bootstrap reads).

**Status: P1 DONE (standalone deployable) + P2 DONE (mTLS service identity +
control-plane CLAIM endpoint) + P3a DONE (control-plane WRITE endpoints + the
`RunStateWriter` seam, flagged, default-direct/reversible). P3b (flip the default,
drop the data-plane tenant-table write grants, per-run scoped creds / Vault
de-privilege) is OUTSTANDING.**

## P1 — process boundary (DONE)

The worker is its own process + compose service, still sharing the same Postgres
and (in P1) the same `job_queue` DB-CAS claim. **Process-boundary change only — NO
trust change** (the data plane held the same broad DB + Vault access; P2/P3 shrink
it).

- [x] **Standalone worker entrypoint** — `services/orchestrator/src/worker-main.ts`
      boots ONLY the worker loop (no HTTP server) via the shared `bootRunWorker()`
      (`engine/worker/boot.ts`): same `tanren_app` + lazy BYPASSRLS `tanren_system`
      pools as the API; reuses `RunWorker` via `startRunWorker` (`lifecycle.ts`).
- [x] **`worker` compose service** (`compose.dev.yml` + `compose.prod.yml`) — the
      orchestrator image, command `start:worker`, same DB/Vault/allocator/runner
      env. Does NOT migrate (the orchestrator owns it; the worker `depends_on` it).
- [x] **API no longer runs the worker in-process by default** — `main.ts` starts
      it ONLY when `TANREN_RUN_WORKER=1` (single-process dev/test); the data plane
      is the `worker` container. Both share `bootRunWorker`, so they can't drift.
- [x] **P1 made no claim-mechanism / API change, no migration** — the worker
      claimed directly from `job_queue` (DB-CAS); the control-plane claim API is P2.
- [x] **Behavior tests** — `tests/workerBoot.test.ts`: `bootRunWorker` builds the
      runtime pool + starts a draining loop; the API enables the in-process worker
      only under `TANREN_RUN_WORKER=1`.
- [x] **Cross-process smoke proof** (`just smoke-plane-split-worker`, in
      `just smoke`): a run enqueued against the shared Postgres is CLAIMED +
      executed + finalized by the SEPARATE `worker` container across the
      boundary, read back under the RLS-enforced `tanren_app` role. (P2 extends
      this to claim over the mTLS endpoint.)

## P2 — service identity + control-plane CLAIM endpoint (DONE)

The worker's JOB-CLAIM moved off direct DB-CAS to an authenticated mTLS
control-plane endpoint. **Claim semantics UNCHANGED** (the endpoint wraps the SAME
`JobQueue.claim` `FOR UPDATE SKIP LOCKED` → CAS — exactly-once preserved, no
migration).

- [x] **mTLS channel (locked decision #3)** — contract seam (`MtlsFetch` /
      `MtlsPeerVerifier`, `contracts/mtlsChannel.ts`; Node impl `mtlsChannelNode.ts`
      pins client cert/key/CA on `node:https`, `requestCert`+`rejectUnauthorized`,
      reads the peer CN). Dev certs by `just gen-mtls-certs`, env-wired
      (`TANREN_INTERNAL_TLS_*` / `TANREN_DATA_PLANE_TLS_*`); mutual-auth, not a PKI.
- [x] **Endpoint** `POST /internal/claim-job` (`routes/internal/claimJob.ts`) on a
      SEPARATE internal mTLS listener (`internalServer.ts`, port 3110), never on the
      public API: authn's the peer FIRST (401 before any DB work), then runs the
      EXISTING claim, returning the job + `org_id` (R3b threading survives).
- [x] **Worker claims over it** — `JobClaimClient` seam (`contracts/jobClaim.ts`):
      `DirectJobClaimClient` (DB-CAS, in-process `TANREN_RUN_WORKER=1`) vs
      `HttpJobClaimClient` (cross-process `worker`, mTLS); `bootRunWorker` picks
      from env (`TANREN_CLAIM_ENDPOINT_URL` + certs → mTLS).
- [x] **Tests** — `tests/internalClaimEndpoint.test.ts` (authn-reject, trusted
      claim + org_id, claim-once-under-contention, transport error) + the
      mTLS-extended `smoke-plane-split-worker` (no-cert claim rejected at TLS; the
      `worker` container claims + executes a `plan` job over mTLS across the boundary).

## P3a — control-plane WRITE endpoints + the `RunStateWriter` seam (DONE, flagged)

The worker's run-state WRITES (event-append, cost-record insert, run finalize)
can route through the control plane over the SAME P2 mTLS channel, so a
compromised runner can't write the control DB. **DIRECT stays the DEFAULT**
(nothing changes unless `TANREN_DATA_PLANE_REMOTE_WRITES=1` → REVERSIBLE),
behavior-identical (same rows + org-scoping), exactly-once (the finalize endpoint
applies the same `status IN (...)` guard → a retry is a no-op).

- [x] **Write endpoints** (`routes/internal/runStateWrites.ts`, internal mTLS
      listener): `POST /internal/{append-event,record-cost,finalize-run}` — authn
      the peer FIRST (401 pre-DB), then the SAME write server-side under
      `runWithOrgScope` REUSING `PgEventStore`/`CostRecorder` (byte-for-byte the
      direct rows).
- [x] **`RunStateWriter` seam** (`contracts/runStateWriter.ts`):
      `DirectRunStateWriter` (in-process, DEFAULT) vs `HttpRunStateWriter` (over
      the mTLS `MtlsFetch`); `bootRunWorker` picks via `buildRunStateWriterFromEnv`.
      `runExecutor.ts` routes its catch-path finalizers (`runFinalize.ts`) + the
      planner workflow's events / cost_records / terminal finalize through the
      writer when remote (`plannerRun.ts` `eventStore`/`recorder`/`finalizeRun`
      seams); the DEFAULT injects nothing → unchanged (#168 passes unchanged).
- [x] **Proof** — `tests/planeSplitP3RemoteWrites.integration.test.ts` (real PG,
      enforced RLS: endpoints persist the same rows org-scoped, authn-reject, the
      writer drives events+finalize, exactly-once, the direct writer byte-identical) + `runStateWriteEndpoint` / `runStateWriterFromEnv` unit tests + `just
smoke-plane-split-p3`. `smoke-plane-split-worker` gained a write-endpoint
      mTLS probe; `smoke-plane-split-worker-remote-writes` re-runs it with the
      worker `TANREN_DATA_PLANE_REMOTE_WRITES=1` (finalize via the control plane,
      end-to-end under enforced RLS).

## P3b — flip the default + drop the data-plane write grants / Vault (OUTSTANDING)

- [ ] Flip remote-writes ON by default + DROP the tenant-table write grants from a
      write-NONE data-plane DB role (future migration; keeps only the `job_queue`
      read). Safe once remote-writes is on — the data plane writes no tenant tables.
- [ ] Per-run scoped credentials (extend GitHub-App minting; move the
      `GithubAppTokenMinter` cache to the control plane); drop Vault root / broad
      secret access from the data plane.
