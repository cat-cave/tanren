set shell := ["bash", "-euo", "pipefail", "-c"]

default:
  just --list

format-check:
  corepack pnpm run format:check

lint:
  corepack pnpm run lint

# Type-aware lint pass (eslint + @typescript-eslint). Slower than oxlint
# because it loads type info; scoped to shipped src. Catches floating/misused
# promises and awaited non-thenables that oxlint (AST-only) cannot.
types-lint:
  corepack pnpm run check:types-lint

architecture:
  corepack pnpm run check:architecture

schema-drift:
  corepack pnpm run check:schema-drift

state-drift:
  corepack pnpm run check:state-drift

event-drift:
  corepack pnpm run check:event-drift

answerer-schema-drift:
  corepack pnpm run check:answerer-schema-drift

contract-schema-drift:
  corepack pnpm run check:contract-schema-drift

# Drift gate for the dashboard's client-side run-detail HTTP types: regenerates
# services/dashboard/src/api/http.gen.ts from contracts/json/http/** and fails
# if the committed file diverges. Same mechanism as contract-schema-drift; this
# is the durable guarantee the BFF↔orchestrator contract can't silently drift.
dashboard-types-drift:
  corepack pnpm run check:dashboard-types-drift

knip:
  corepack pnpm run check:knip

# Re-fetch LiteLLM's maintained model-price source and re-vendor the snapshot at
# services/orchestrator/src/engine/costs/pricing/model_prices.json. Run on a
# schedule so the snapshot stays current with upstream (providers add/adjust
# models). SCHEDULING NOTE: wire this into the existing scheduled-CI lane (the same
# lane the scheduled mutation-CI runs on) as a follow-up — this PR adds only the
# recipe, not a CI cron trigger. Use `--check` in CI to fail on a stale snapshot.
refresh-model-prices:
  node scripts/refresh-model-prices.mjs

spelling:
  corepack pnpm run check:spelling

typecheck:
  corepack pnpm run typecheck

fast-check: format-check lint types-lint architecture schema-drift state-drift event-drift answerer-schema-drift contract-schema-drift dashboard-types-drift knip spelling typecheck test compose-config

test:
  corepack pnpm run test

# Stryker mutation testing — Track C §5 of
# docs/architecture/portability-and-longevity.md. Turns test-strength into a
# number on the workflow-critical + seam modules (planner/checker/auditor,
# engine/credentials/**, and the Allocator/JobQueue/SecretStore seams). SLOW:
# deliberately NOT part of `just ci` / `just fast-check`. Run on demand or
# nightly. Scope + thresholds live in stryker.config.mjs.
mutation:
  corepack pnpm run check:mutation

# WHOLE-REPO mutation (services/orchestrator/src/**) via stryker.full.mjs.
# EXPENSIVE — NOT for per-PR CI. Driven on demand and by the WEEKLY scheduled
# job (.github/workflows/mutation-weekly.yml). Per-cluster `break` floors gate
# regressions; this run tracks the global trend. See
# docs/contracts/mutation-testing.md.
mutation-full:
  corepack pnpm exec stryker run stryker.full.mjs

# Run one named mutation cluster, e.g. `just mutation-cluster repos` →
# stryker.repos.mjs. Clusters: runloop alloc wf forge notify secrets inbox
# auth costs repos worker dal. Each carries its own ratcheted `break` floor.
mutation-cluster cluster:
  corepack pnpm exec stryker run stryker.{{cluster}}.mjs

build:
  corepack pnpm run build

compose-config:
  corepack pnpm run compose:config

ci: format-check lint types-lint architecture schema-drift state-drift event-drift answerer-schema-drift contract-schema-drift dashboard-types-drift knip spelling typecheck test build compose-config

compose-build:
  docker compose -f compose.dev.yml build orchestrator worker allocator dashboard runner

runner-key:
  test -f /tmp/tanren_runner_key || ssh-keygen -t ed25519 -N "" -f /tmp/tanren_runner_key

# Plane-split P2: generate the dev control↔data-plane mTLS material (CA + server
# + worker certs) into /tmp/tanren-mtls, bind-mounted into the orchestrator +
# worker by compose.dev.yml. Idempotent. Prod supplies real certs via the same env.
gen-mtls-certs:
  ./scripts/dev/gen-mtls-certs.sh

# Host-side sanity-check for the usage tools (codexbar live windows + ccusage
# token accounting) against a real CODEX_HOME. In a real run these execute
# runner-side over SSH; this recipe just lets an operator eyeball the tools.
usage provider="codex" cli="codex" codex_home="":
  scripts/usage/print-usage.sh {{provider}} {{cli}} {{codex_home}}

# Dev profile: developer ergonomics. Static Vault root token, exposed
# Postgres/runner SSH/orchestrator/dashboard/ntfy host ports, no required env.
up-dev: runner-key gen-mtls-certs
  TANREN_RUNNER_AUTHORIZED_KEY="$(cat /tmp/tanren_runner_key.pub)" TANREN_RUNNER_IDENTITY_PRIVATE_KEY="$(cat /tmp/tanren_runner_key)" docker compose -f compose.dev.yml up -d postgres vault orchestrator worker allocator dashboard runner ntfy

down-dev:
  docker compose -f compose.dev.yml down -v

# Prod profile: fails fast if required env is missing. Operator must run
# `just vault-init-prod` once before `just up-prod`. See
# docs/operator-guide/deploy.md.
up-prod:
  docker compose -f compose.prod.yml up -d postgres vault orchestrator dashboard runner ntfy

down-prod:
  docker compose -f compose.prod.yml down

# Operator-run once per fresh Vault: writes the GitHub OAuth client secret to
# the Vault path the orchestrator reads, and ensures per-service AppRoles
# exist. Idempotent.
vault-init-prod:
  ./scripts/vault-init/run.sh prod

# Backward-compat aliases for the Phase 1 recipe names.
compose-up: up-dev

compose-down: down-dev

wait-for-stack:
  ./scripts/wait-for-url.sh http://localhost:3100/healthz
  ./scripts/wait-for-url.sh http://localhost:3000/healthz

# Stack connectivity smoke: the orchestrator's `/healthz` (DB + Vault) via the
# CLI `doctor`, plus raw SSH reachability of the runner container. This replaces
# the old `smoke-hello`, which drove a SYNTHETIC fake-adapter workflow that no
# longer exists in runtime source. The SSH SUBSTRATE path (the orchestrator's
# real Ssh2Substrate) is proven separately by `smoke-ssh-integration`.
smoke-connectivity:
  corepack pnpm --filter @tanren/cli tanren doctor
  ssh -i /tmp/tanren_runner_key -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/tanren_runner_known_hosts tanren@localhost 'echo tanren-runner-ok'

smoke-ssh-integration:
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_SSH_INTEGRATION=1 TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/ssh.integration.test.ts

live-codex-writer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexWriter.live.test.ts

live-codex-answerer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_ANSWERER_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexAnswerer.live.test.ts

live-github-draft-pr:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  test -n "${TANREN_GITHUB_REPO_URL:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_GITHUB_LIVE=1 TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" TANREN_GITHUB_REPO_URL="${TANREN_GITHUB_REPO_URL}" TANREN_GITHUB_BASE_BRANCH="${TANREN_GITHUB_BASE_BRANCH:-main}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/githubDraftPr.live.test.ts

live-ci-poll:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" corepack pnpm exec vitest run services/orchestrator/tests/ciPolling.test.ts -t "live CI polling fixture"

live-phase1-fixture:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  test -n "${TANREN_GITHUB_REPO_URL:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_PHASE1_FIXTURE_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" TANREN_GITHUB_REPO_URL="${TANREN_GITHUB_REPO_URL}" TANREN_GITHUB_BASE_BRANCH="${TANREN_GITHUB_BASE_BRANCH:-main}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/phase1Fixture.live.test.ts

# RLS wave R1 behavior proof against the real Postgres the smoke stack runs.
# Provisions an ephemeral DB on the server, migrates it as owner, then connects
# as the restricted `tanren_app` role to prove the org session context + that
# the role can do every existing operation while no policies are present.
# DATABASE_URL is the OWNER/superuser connection (the migration role).
smoke-rls-r1:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR1SessionContext.integration.test.ts

# RLS wave R2 cohort-1 behavior proof: the runs + events read/write loaders run
# through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1.
smoke-rls-r2:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalRunsEvents.integration.test.ts

# RLS wave R2 cohort-2 behavior proof: the tasks + cost_records read/write sites
# run through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1 / cohort-1.
smoke-rls-r2-cohort2:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalTasksCosts.integration.test.ts

# RLS wave R2 cohort-3 behavior proof: the specs + runners read/write sites + the
# worker failure-path finalize UPDATE run through the org-scoped client (inert —
# no policies), identical to the pool. Same ephemeral-DB + restricted-role
# harness as R1 / cohort-1 / cohort-2.
smoke-rls-r2-cohort3:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalSpecsRunnersFinalizers.integration.test.ts

# RLS wave R2 cohort-4 (FINAL) behavior proof: the forge stores —
# forge_threads / forge_turns / forge_action_proposals reads + writes — run
# through the org-scoped client (inert — no policies), identical to the pool.
# Same ephemeral-DB + restricted-role harness as R1 / cohort-1/2/3. After this
# all conversion cohorts are complete; only R3 (policies + role flip) remains.
smoke-rls-r2-cohort4:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalForge.integration.test.ts

# RLS wave R3a behavior proof: the residual cohort-4-flagged tenant-table sites
# — the forge read/write tool dispatchers + `engine/recovery`'s
# openInspectionThread + the narration insights-cache read — now run through the
# org-scoped client (inert — no policies), identical to the pool, and
# openInspectionThread stamps forge_threads.org_id. Same ephemeral-DB +
# restricted-role harness as R1 / R2 cohorts. After this every REQUEST-reachable
# tenant query carries context; the worker per-job WORKFLOW execution is the one
# remaining surface to scope before R3b (see docs/roadmap/R-WAVES.md).
smoke-rls-r3a:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3aResidualSites.integration.test.ts

# RLS wave R3a-worker behavior proof: the per-job WORKFLOW execution carries org
# context on EVERY tenant-table op (tasks / events / cost_records). Installs a
# temporary GUC-keyed policy on the restricted `tanren_app` role and proves the
# worker's actual store helpers, run under `runWithJobOrgId` + `orgScopingPool`,
# write rows the policy admits (every op set the GUC), while the bare-pool
# no-job-org fallback is rejected (empty GUC). Final conversion gating R3b. Same
# ephemeral-DB + restricted-role harness as R1 / R2 cohorts / R3a.
smoke-rls-r3a-worker:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3aWorkerScoping.integration.test.ts

# RLS wave R3b ENFORCEMENT proof: runs the REAL migration (which enables RLS +
# policies on every tenant table and creates the tanren_app / tanren_system
# roles), then connects as the restricted `tanren_app` role and proves DB-level
# two-org isolation — org A sees zero of org B's rows, an unset GUC returns zero
# (deny-by-default), a WITH CHECK write for the wrong org is rejected, a
# correctly-scoped read/write is unchanged, and the BYPASSRLS `tanren_system`
# role reads across orgs (the documented carve-out). Same ephemeral-DB harness
# as R1 / R2 / R3a. DATABASE_URL is the OWNER/superuser connection.
smoke-rls-r3b:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR3bEnforcement.integration.test.ts

# RLS early-failure finalize proof: a run that throws BEFORE the per-job org
# scope is established (a credential-free run → MissingCredential during context
# hydration) must still reach a terminal FINALIZED state, not get stuck `queued`.
# Runs the REAL migration (RLS enabled), drives the worker's real claim→execute
# path on the restricted `tanren_app` pool, and asserts the run lands `halted` —
# the early-failure finalize now org-scopes from the CLAIMED org so the policy
# admits its UPDATE. Same ephemeral-DB + restricted-role harness as the R-wave
# cohorts. Regression lock for fix/rls-early-failure-finalize-scope.
smoke-rls-early-finalize:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsEarlyFailureFinalize.integration.test.ts

# RLS org-creation bootstrap proof: org creation is a tenant BOOTSTRAP that
# precedes any org scope — signup / dev-login / onboarding call
# IdentityStore.upsertIdentity (→ upsertOrg + ensureOrgMembership) with no
# `app.current_org_id`, so under enforced RLS the deny-by-default policy rejected
# the `organizations` / `org_members` INSERT with 42501 (signup 500'd). Runs the
# REAL migration (RLS enabled), then under the restricted `tanren_app` role
# proves: an org-creating signup on the bare app pool is REJECTED (42501), the
# SAME signup SUCCEEDS via the BYPASSRLS `tanren_system` pool (the bootstrap
# routes through runWithSystemScope), and READS stay under RLS — the new org is
# visible only in its own org scope, not on the unset-GUC pool nor another org's
# scope. Same ephemeral-DB + restricted-role harness as the R-wave cohorts.
# Regression lock for fix/rls-org-creation-bootstrap-scope.
smoke-rls-org-bootstrap:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsOrgCreationBootstrap.integration.test.ts

# RLS operator/control-plane flow (real PG, enforced `tanren_app` role): drives
# the LITERAL operator walk live validation found broken — dev-login bootstrap →
# list MY orgs (user-scoped `runWithSystemScope` read) → read org config → pass
# the org-access gate (proves `resolveActorContext` saw the membership) → create
# + list a project (org-scoped CRUD via the per-request scope + `orgScopingPool`)
# → create + list a spec. Every step must succeed under enforcement; pre-fix the
# actor resolved with no org scope and the `/orgs/:orgId/*` routes 403'd / read
# empty. Regression lock for fix/rls-operator-routes-scope.
smoke-rls-operator-flow:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsOperatorFlow.integration.test.ts

# RLS HTTP-route scoping (real PG, enforced `tanren_app` role): drives the FULL
# operator→run flow live validation walked, across ALL route shapes — including
# the RESOURCE-keyed root routes #181 left unscoped. bootstrap (multi-org) →
# list orgs → import + LIST credentials (non-empty) → create project → create
# spec → trigger run via `POST /specs/:specId/runs` (the live `spec_not_found`
# 404; MUST 201) → read run status `GET /runs/:runId` → read events → recovery
# surface. The user is MULTI-org so the sole-org fallback cannot fire — the
# resource→org middleware arm is what scopes the resource routes. Pre-fix the
# resource-keyed steps 404 under enforcement. Regression lock for
# fix/rls-http-route-scoping-complete.
smoke-rls-http-route-scoping:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsHttpRouteScoping.integration.test.ts

# RLS full-run-lifecycle scoping proof: a REAL org-scoped run drives the REAL
# allocator + runner allocation + the whole plan→write→check→audit→PR→CI→review→
# merge→finalize loop on the enforced `tanren_app` role, with a DETERMINISTIC fake
# harness + stubbed SSH/GitHub transports. Asserts EVERY tenant write (runners,
# tasks, events, cost_records, specs, runs) is admitted by RLS — the coverage gap
# the system/bypass hello smoke never hit, where the runner-allocation INSERT (run
# OUTSIDE an open connection scope) was RLS-denied in live validation. Runs the
# REAL migration (RLS enabled). Regression lock for fix/rls-run-lifecycle-scoping.
smoke-rls-run-lifecycle:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsRunLifecycleScoping.integration.test.ts

# Workstream D de-priv proof: the STANDALONE allocator service's PgRunnerStore
# writes the tenant `runners` row INSIDE the run's org scope (restricted app-role
# pool via `runWithOrgScope`) — visible under that org, zero under another, and a
# wrong-org write RLS-denied — while the cross-org sweeper/release path stays on
# the BYPASSRLS system pool. Runs the REAL migration (RLS enabled).
smoke-rls-allocator:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/allocator/tests/pgRunnerStore.rls.integration.test.ts

# P8b: the e2e gate's ARTIFACT-READ teeth against a real Postgres. The `just e2e`
# harness reads the real persisted run / cost_records / DORA rows via
# `readRunArtifacts`; this proves that SQL actually returns a seeded merged run
# (not just asserts verdict logic over hand-built evidence). Provisions an
# ephemeral DB, migrates it, seeds a minimal `done` run (outcome + pr_url) + a
# cost_records row, and asserts `readRunArtifacts` returns it. Gated behind the
# same TANREN_RLS_DB_TEST switch as the RLS integration smokes; the credentialed
# CASES themselves run only under `just e2e`.
smoke-e2e-artifacts:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run tests/e2e/lib/readRunArtifacts.db.test.ts

# Plane-split P1 cross-process proof: the run-executor worker is a STANDALONE
# deployable. Seeds a queued plan job against the shared Postgres (the same
# job_queue insert the control-plane API does), then waits for the SEPARATE
# `worker` compose container to claim + execute + finalize it across the
# API↔worker process boundary — read back under the RLS-enforced `tanren_app`
# runtime role. No worker runs in-process here; if the `worker` service were
# down the job would stay queued and this smoke would time out. Credential-free,
# so the worker lands the run in a recoverable `halted` state — the proof is the
# boundary crossing + the worker-written terminal state, not a green run. See
# docs/roadmap/saas-rls-and-plane-split-plan.md (P1).
smoke-plane-split-worker:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts

# Plane-split P3 (real PG, enforced RLS): the control-plane run-state WRITE
# endpoints + the writers. Proves authn-reject, that append-event / record-cost /
# finalize-run persist the SAME rows server-side under the run's org scope, that
# finalize is exactly-once (a retried finalize is a no-op), and that the DEFAULT
# DirectRunStateWriter persists byte-identical rows in-process. Same ephemeral-DB
# + restricted-role harness as the R-wave cohorts. DATABASE_URL is the owner.
smoke-plane-split-p3:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/planeSplitP3RemoteWrites.integration.test.ts

# Plane-split P3b (real PG): the DE-PRIVILEGE proof. Migrates a fresh DB (creates
# the `tanren_dataplane` role + drops its events/cost_records write grants), then
# proves under that role: a direct INSERT INTO events / cost_records is REJECTED
# for the privilege (42501), the cost_records READ is kept, the `job_queue` system
# write is kept, and the control-plane `tanren_app` role can still insert the same
# event (contrast). DATABASE_URL is the owner.
smoke-plane-split-p3b:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/planeSplitP3bDeprivilege.integration.test.ts

# Plane-split P3c (real PG): the run/spec/task LIFECYCLE de-privilege proof.
# Migrates a fresh DB (0035 drops the data plane's runs/specs/tasks WRITE grants),
# then proves under `tanren_dataplane`: a direct UPDATE runs / UPDATE specs /
# INSERT|UPDATE tasks is REJECTED for the privilege (42501), the SELECT on all
# three is kept, and the control-plane `tanren_app` role CAN run the same writes
# (so the lifecycle still works through the control plane). DATABASE_URL is owner.
smoke-plane-split-p3c:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/planeSplitP3cDeprivilege.integration.test.ts

# Plane-split P3b cross-process CUTOVER proof. The compose `worker` now DEFAULTS
# to the de-privileged `tanren_dataplane` role + remote-writes ON, so the regular
# `smoke-plane-split-worker` already runs the cutover topology; this recipe makes
# it explicit + adds the LIVE negative test: connect to the running stack as
# `tanren_dataplane` and confirm a direct tenant-table write (events) is denied by
# Postgres. Recreates the worker (idempotent, same defaults) so the stack is
# restored.
smoke-plane-split-worker-remote-writes: gen-mtls-certs
  TANREN_RUNNER_AUTHORIZED_KEY="$(cat /tmp/tanren_runner_key.pub)" TANREN_RUNNER_IDENTITY_PRIVATE_KEY="$(cat /tmp/tanren_runner_key)" docker compose -f compose.dev.yml up -d --no-deps --force-recreate worker
  TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1 DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" corepack pnpm exec tsx scripts/smoke/plane-split-worker.ts

smoke: compose-build compose-up wait-for-stack smoke-connectivity smoke-ssh-integration smoke-plane-split-worker smoke-plane-split-worker-remote-writes smoke-plane-split-p3 smoke-plane-split-p3b smoke-plane-split-p3c smoke-rls-r1 smoke-rls-r2 smoke-rls-r2-cohort2 smoke-rls-r2-cohort3 smoke-rls-r2-cohort4 smoke-rls-r3a smoke-rls-r3a-worker smoke-rls-r3b smoke-rls-early-finalize smoke-rls-org-bootstrap smoke-rls-operator-flow smoke-rls-http-route-scoping smoke-rls-run-lifecycle smoke-rls-allocator smoke-e2e-artifacts

# P3-0001: the Phase 2A direct-execution acceptance gate (`just acceptance`,
# scripts/acceptance/easy.ts + medium.ts) was removed once the run executor
# landed. The system is now only ever exercised through the real
# dequeue→execute path (the background run worker, TANREN_RUN_WORKER=1). The
# per-tier persisted-state ASSERTIONS still ship as CI dry-run smokes
# (services/orchestrator/tests/phase2Acceptance{Easy,Medium}.test.ts) which
# import scripts/acceptance/common.ts. Component-level live smokes
# (live-codex-*, live-github-*, live-ci-poll, live-phase1-fixture) remain.

# P3-0026: the final v0 acceptance HARD tier. Runs the DETERMINISTIC hard-tier
# test — the real runPlannerLoopWorkflow through the worker's claim→execute seam
# (executeNextPlanJob) with adapters/gate/review/merge probes scripted to force
# a planner re-plan, an auditor rejection loop, and a conflict-resolution merge.
# No live Codex/SSH/GitHub. The live fixture-hard scenario (triggered through the
# dashboard with TANREN_RUN_WORKER=1) is documented in docs/operator-guide/acceptance.md.
acceptance-hard:
  corepack pnpm exec vitest run services/orchestrator/tests/acceptanceHardTier.test.ts

# P8b: the real-resource, real-CREDENTIAL e2e gate (autonomy-engine §8b). OPT-IN /
# nightly / pre-release — NOT on the per-PR fast path: it runs the REAL stack
# (`just up-dev`) with REAL provider + GitHub credentials, spends real credits +
# wall-clock, and drives the REAL operator flow over the REAL external surfaces
# only (HTTP API + dashboard). It FORBIDS test fixtures / mock adapters entirely —
# the `e2e-no-mock-imports` arch check (in `just architecture`, on the fast path)
# fails any tests/e2e/** file that imports a fixture/mock or a non-public internal
# seam. Each case asserts on REAL persisted artifacts (a merged PR on GitHub, the
# implemented file on the base branch, cost_records rows with a real basis, the
# DORA projection) — never on a mocked return; its result (run IDs + PR URLs) is
# the release evidence. NEVER runs in public PR CI (no secrets there — same
# discipline as `just acceptance`). Credentials live in tanren.acceptance.json +
# TANREN_E2E_API_TOKEN; the stack must be up first (`just up-dev`). The harness's
# own unit tests run on the fast path via `just test` (tests/e2e/lib/**). See
# docs/operator-guide/e2e.md.
e2e:
  test -f tanren.acceptance.json || test -n "${TANREN_ACCEPTANCE_CONFIG:-}"
  test -n "${TANREN_E2E_API_TOKEN:-}"
  corepack pnpm exec vitest run --config vitest.e2e.config.ts
