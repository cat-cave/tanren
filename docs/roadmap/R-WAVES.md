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

## R2 — enable policies + flip the runtime role

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
- [ ] `routes/runs` remaining surfaces (events/costs pages, feed, SSE deltas,
      Forge bundle) — R1 converted only the detail snapshot.

### Orchestrator engine (write + read paths)

- [ ] Event store (`engine/eventStore.ts`) and the workflow finalize updates
- [ ] Task/cost recording (`engine/workflow/subtask*`, usage/metering)
- [ ] Credential-resolution reads (`engine/credentials/**`)
- [ ] Quota reads/accrual (`engine/quota/**`)
- [ ] Insights compute/cache (`engine/insights/**`)

### Dashboard + CLI

- [ ] Dashboard server read surfaces that query Postgres directly
- [ ] CLI paths that read Postgres directly

Each item is DONE when its queries run through the org-scoped client AND a
behavior test proves the rows it returns match the scope.
