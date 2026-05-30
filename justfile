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
# repos worker dal. Each carries its own ratcheted `break` floor.
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

smoke-hello:
  corepack pnpm --filter @tanren/cli tanren doctor
  summary="$(corepack pnpm --filter @tanren/cli tanren hello)"; echo "$summary"; run_id="$(printf '%s' "$summary" | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => console.log(JSON.parse(input).runId));')"; corepack pnpm --filter @tanren/cli tanren status "$run_id"
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

# RLS wave R2 cohort-3 behavior proof: the specs + runners + org_quotas read/write
# sites + the worker failure-path finalize UPDATE run through the org-scoped
# client (inert — no policies), identical to the pool. Same ephemeral-DB +
# restricted-role harness as R1 / cohort-1 / cohort-2.
smoke-rls-r2-cohort3:
  DATABASE_URL="${DATABASE_URL:-postgres://tanren:tanren@localhost:5432/tanren}" TANREN_RLS_DB_TEST=1 corepack pnpm exec vitest run services/orchestrator/tests/rlsR2DalSpecsRunnersQuota.integration.test.ts

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

smoke: compose-build compose-up wait-for-stack smoke-hello smoke-ssh-integration smoke-plane-split-worker smoke-rls-r1 smoke-rls-r2 smoke-rls-r2-cohort2 smoke-rls-r2-cohort3 smoke-rls-r2-cohort4 smoke-rls-r3a smoke-rls-r3a-worker smoke-rls-r3b smoke-rls-early-finalize

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
