# Documentation and Code-Comment Drift Audit

Audit target: `main` at `8f712eea` (#853). This audit found **12 confirmed findings**: **2 P0**, **3 P1**, and **7 P2** (no P3 findings). Findings below are limited to claims contradicted by the current implementation or its closed event/schema vocabulary; no unverified candidates are included.

## P0

### 1. GitHub App guide documents a deleted static-token environment fallback

- **Severity:** P0
- **Location:** `docs/operator-guide/github-app.md:60,96-98`
- **Claim:** “`TANREN_GITHUB_APP_TOKEN_REF` | (optional) static-token ref for the no-App path” and “the configured `credential/github/...` ref (or `TANREN_GITHUB_APP_TOKEN_REF`) is read from Vault.”
- **Reality:** `services/orchestrator/src/engine/credentials/githubTokenResolver.ts:8-12` says the static ref comes **only** from the caller’s `staticRef` (resolved project/org configuration) and that there is “NO deploy-env fallback.” `services/orchestrator/src/engine/credentials/githubTokenResolver.ts:90-92` throws if that `staticRef` is absent. The resolver does not read `TANREN_GITHUB_APP_TOKEN_REF`.
- **Fix:** Remove the `TANREN_GITHUB_APP_TOKEN_REF` table row and replace the static-token sentence with: “Otherwise, the resolver reads the static `github_token` credential ref resolved from the run override, project configuration, or org default. If neither that ref nor an App installation exists, the run fails configuration validation.”

### 2. Failure-recovery guide tells operators to wait for a non-existent halt event

- **Severity:** P0
- **Location:** `docs/operator-guide/failure-recovery.md:79-80`; `docs/design/acceptance-criteria/failure-recovery.md:25`; `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts:17-19`
- **Claim:** The guide says “A `run.halted` notification fires … when a run halts”; the acceptance criteria and the severity-taxonomy comment likewise present `run.halted` as the notification event.
- **Reality:** The closed event vocabulary contains `run.cancelled`, `run.completed`, `run.failed`, `run.paused`, `run.queued`, and `run.resumed` at `db/src/eventTypes.ts:151-156`; it has no `run.halted`. The runtime severity map likewise maps `run.failed` at `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts:27-30`.
- **Fix:** Replace `run.halted` with `run.failed`, and state that the persisted run status may be `halted` while the terminal event operators receive is `run.failed`.

## P1

### 3. Notification severity guide names removed CI and fixture events

- **Severity:** P1
- **Location:** `docs/operator-guide/notifications.md:44-47`
- **Claim:** The table assigns defaults to `ci.passed`, `ci.failed`, and `phase1.fixture.failed`.
- **Reality:** The live vocabulary provides `gate.failed`, `gate.passed`, and `gate.verdict` at `db/src/eventTypes.ts:84-90`, while `services/orchestrator/src/engine/events/schemas/gate.ts:75-86` defines `gate.passed` and `gate.failed` as the native gate outcomes. None of the three documented event names appears in the current event-type registry.
- **Fix:** Change the `ok` example to `run.completed`, `gate.passed`, `github.pr.merged`; change the `warn` example to `gate.failed`, `*.failed`, and an answerer verdict; replace the obsolete fixture example with `run.failed` (or remove that example).

### 4. Benchmark roadmap still uses removed `ci.passed` events as metrics inputs

- **Severity:** P1
- **Location:** `docs/roadmap/tanren-method-benchmark.md:168-169`
- **Claim:** “Time-to-green” is derived from “`gate.*` / `ci.passed`,” and gate pass-rate uses “`gate.failed`/`ci.passed`.”
- **Reality:** `services/orchestrator/src/engine/insights/ci/compute.ts:2-6` explicitly says native delivery replaced `ci.started`/`ci.passed`/`ci.failed` observations and analytics now reduce Tanren’s own `gate.verdict` events. The closed registry lists `gate.passed`, `gate.failed`, and `gate.verdict` at `db/src/eventTypes.ts:84-90`.
- **Fix:** Replace both `ci.passed` references with `gate.passed` or, where the roll-up semantics matter, `gate.verdict`.

### 5. Environment-management architecture instructs a removed template-creation flow to emit removed events

- **Severity:** P1
- **Location:** `docs/architecture/environment-management.md:208-227`
- **Claim:** It directs `engine/templates/creation/liveResearch.ts` and `creationUpgrade.ts` to run a template-creation upgrade flow and emit `template.creation.upgrade_skipped` / `template.creation.upgraded`.
- **Reality:** The current event registry only registers the fragment-authoring lifecycle at `services/orchestrator/src/engine/events/schemas/templates.ts:79-84`, and its event names are listed at `db/src/eventTypes.ts:80-83`. The live onboarding path directs an operator to inspect `fragment.authoring.failed` at `services/orchestrator/src/routes/onboarding/index.ts:362-365`.
- **Fix:** Replace this obsolete template-creation subsection with the current fragment-only statement: missing fragments enter the F2 authoring loop, and operators inspect `fragment.authoring.{started,attempt,succeeded,failed}`. Do not prescribe template-creation paths or `template.creation.*` events.

## P2

### 6. CI-flaky schema comment still describes removed CI observation events

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/events/schemas/ciFlaky.ts:3-8`
- **Claim:** “Tanren records per-run CI observations (`ci.passed` / `ci.failed` …).”
- **Reality:** `services/orchestrator/src/engine/insights/ci/compute.ts:2-6` states that those forge-CI observations were replaced and the system reduces `gate.verdict`; `db/src/eventTypes.ts:84-90` contains the live `gate.*` vocabulary and no `ci.passed` or `ci.failed`.
- **Fix:** Replace the opening claim with: “Tanren derives flaky-test evidence from native `gate.verdict` observations …” and retain `ci.flaky.detected` / `ci.test.quarantined` as the emitted insight events.

### 7. DAG lifecycle comment still uses `ci.passed` for the CI-green transition

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/contracts/dagLifecycle.ts:10-14,181-185`
- **Claim:** The latest-run lifecycle derives from `ci.passed`, and “`ci.passed` ⇒ `ci_green`.”
- **Reality:** Native gate outcomes are `gate.passed`, `gate.failed`, and the lifecycle roll-up `gate.verdict` (`db/src/eventTypes.ts:84-90`; `services/orchestrator/src/engine/events/schemas/gate.ts:175-177`). `services/orchestrator/src/engine/insights/ci/compute.ts:2-6` confirms the old `ci.*` observations were replaced.
- **Fix:** Replace `ci.passed` with the appropriate native gate signal (`gate.passed` for the single tier transition, or `gate.verdict` if the projection consumes the roll-up).

### 8. jj-local comments still present a removed kill switch as a live condition

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/workflow/plannerRunJjLocalBootstrap.ts:5-10`; `services/orchestrator/src/engine/dag/jjLocalBootstrap.ts:31-33`; `services/orchestrator/src/engine/dag/baseShiftLiveResolve.ts:66-69`; `services/orchestrator/src/engine/workflow/plannerRunWorkspace.ts:72-75`; `services/orchestrator/src/engine/workflow/plannerRunAdapters.ts:225-228`
- **Claim:** These comments say that jj-local bootstrap/base-shift occurs when `WALKER_JJ_LOCAL_BASE` is “on,” “default-OFF,” or that the path is not wired until that flag.
- **Reality:** The live workspace chooser unconditionally takes the jj-local branch whenever `ancestorStack` is non-empty: `services/orchestrator/src/engine/workflow/plannerRunWorkspace.ts:282-290`. Likewise, base-shift locally assembles whenever the supplied stack is non-empty at `services/orchestrator/src/engine/dag/baseShiftLiveResolve.ts:145-150`. There is no flag check in either live path.
- **Fix:** Remove all flag/default-off language. Describe the condition as “when the ancestor stack is non-empty”; retain the plain default-branch clone only for an empty stack.

### 9. Several active comments still describe `VcsProvider` as the live integration seam

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/contracts/mergeCoordinator.ts:12-15`; `services/orchestrator/src/engine/merge/batchCoordinatorBuild.ts:3-6`; `services/orchestrator/src/engine/merge/coordinatorBuild.ts:8-12`; `services/orchestrator/src/engine/workspace/githubPush.ts:19-23`
- **Claim:** The comments say queue VCS/CI calls go through `VcsProvider`, the batch checker uses a “VcsProvider branch-CI seam,” and the workspace-push caller is `VcsProvider`.
- **Reality:** `services/orchestrator/src/engine/providers/hostFactory.ts:1-4,55-58` constructs the live `CodeHost` and hardened `VisibilityProjection` seams. `services/orchestrator/src/engine/contracts/codeHost.ts:1-13` defines `CodeHost` as the post-decomposition host surface and states Tanren is the merge authority.
- **Fix:** Name the actual seam for each operation: `CodeHost` for host/ref operations, `VisibilityProjection` for forge mirrors, `WorkspaceVcsCore` for runner-local VCS, and the native gate for CI. Remove “caller (the VcsProvider)” from `GitHubWorkspacePushInput`.

### 10. Schema and integration-node comments describe dropped columns and an unread additive stack

- **Severity:** P2
- **Location:** `db/src/schemaCore.ts:204-206`; `services/orchestrator/src/engine/dag/integrationNodesPg.ts:1-17`; `services/orchestrator/src/routes/internal/runStateLifecycleWrites.ts:102-104`
- **Claim:** `ancestor_stack` is “ADDITIVE — dual-written but UNREAD”; `integration_nodes` projects existing `runs.speculative_base` / `integrated_ancestor_shas`; and the lifecycle writer “NULLed” `speculative_base`.
- **Reality:** The current `runs` schema has `ancestorStack` at `db/src/schemaCore.ts:204-206` and no `speculative_base` or `integrated_ancestor_shas` field. The live context selects and resolves `r.ancestor_stack` at `services/orchestrator/src/engine/worker/runExecutionContext.ts:137-163`, and the lifecycle SQL writes only `ancestor_stack` at `services/orchestrator/src/engine/worker/runStateLifecycleSql.ts:102-113`.
- **Fix:** Rewrite these comments to call `ancestor_stack` the sole jj-local base source. Remove references to dual-write/unread behavior and to nulling or reading the dropped columns.

### 11. jj-local design document calls the deleted server-side implementation the current path

- **Severity:** P2
- **Location:** `docs/architecture/walker-jj-local-integration-design.md:22-50`
- **Claim:** “Why a synthesized ref exists today” / “The current server-side path” says `PgSpeculativeIntegrator` and `VcsProvider.buildIntegrationBranch` create `runs.speculative_base`.
- **Reality:** The same document’s status block says the cutover is implemented and `PgSpeculativeIntegrator` and `WALKER_JJ_LOCAL_BASE` are deleted at `docs/architecture/walker-jj-local-integration-design.md:3-10`. The live worker instead resolves `runs.ancestor_stack` at `services/orchestrator/src/engine/worker/runExecutionContext.ts:160-163`.
- **Fix:** Retitle this section “Pre-cutover server-side path (deleted)” and change present tense (“exists today,” “current”) to explicit historical tense throughout the subsection.

### 12. Scoped-credential comment incorrectly says the allocator still uses `TANREN_MAX_RUN_HOURS`

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/workflow/plannerRunScopedCreds.ts:157-175`
- **Claim:** The comment calls `TANREN_MAX_RUN_HOURS` “the SAME value the allocator’s abandoned-runner sweeper uses” and says the runner is reaped at that ceiling.
- **Reality:** `services/allocator/src/envSchema.ts:16-21` says there is no allocator wall-clock reap knob and that `TANREN_MAX_RUN_HOURS` is only the orchestrator’s scoped-credential TTL. The allocator schema instead exposes sign-of-life sweep settings at `services/allocator/src/envSchema.ts:55-64`.
- **Fix:** Describe `TANREN_MAX_RUN_HOURS` solely as the scoped-credential token TTL ceiling. Remove the claimed allocator coupling and any statement that a runner is reaped at that duration.
