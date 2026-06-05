# ROADMAP.md

Tanren v0 is built by progressively making the hello-world workflow more real until a persisted spec is planned, implemented, reviewed, PR'd, gated by Tanren's **own native checks**, merged, and deployed by the platform. Delivery is Action-less: the gate runs over SSH and is the merge authority — there is no injected GitHub Actions workflow in the delivery path. (Tanren's own monorepo CI runs on GitHub Actions, which is orthogonal.) This file is the phase history; the live forward tracker is `docs/roadmap/tempering.md`, and the native-delivery doctrine is embodied in `README.md` + `PROJECT_BRIEF.md`.

## Completed Baseline: Hello-World Connectivity

Status: done.

This baseline proves the first technology boundaries in `PROJECT_BRIEF.md` are wired:

- Docker Compose starts Postgres, Vault, orchestrator, dashboard, ntfy, and a runner container.
- The orchestrator migrates Postgres, checks Vault, runs fake Writer/Answerer adapters, and persists a completed run.
- The dashboard reads run/event/cost state from Postgres.
- The thin CLI calls the orchestrator.
- CI builds, checks, tests, and smoke-tests the stack.
- Runner SSH is reachable from outside the stack.

Verification recorded on 2026-05-21:

- `corepack pnpm run check`
- `corepack pnpm --filter @tanren/cli tanren doctor`
- `corepack pnpm --filter @tanren/cli tanren hello`
- `corepack pnpm --filter @tanren/cli tanren status <run_id>`
- `ssh -i /tmp/tanren_runner_key -p 2222 tanren@localhost 'echo tanren-runner-ok'`

Real LLM CLIs, real credentials, real GitHub PR automation, and remote allocators remain deferred until the kernel contracts below are stable.

## Phase 0: Kernel

Status: done.

Phase 0 is sequential. Each spec defines a contract consumed by the next spec, so parallel worktrees are intentionally deferred until these contracts are boring.

Phase 0 starts from the completed hello-world baseline and ends when a fake writer can mutate a real git workspace through the same local runner execution boundary that real agents will use later.

### SPEC-0001 - schema-source-of-truth

**Owns**: `db/src/schema.ts`, `db/migrations/**`, `db/package.json`, `package.json`, `pnpm-lock.yaml`, `drizzle.config.ts`, `scripts/**` migration/schema checks, `docs/contracts/architecture-checks.md`.
**Consumes**: completed hello-world baseline.
**Produces**: a type-checked database schema contract and generated migration workflow.

**What**: Make the typed Drizzle schema the single source of truth for database shape and generate committed SQL migrations from it.
**Why**: The current SQL migration and TypeScript schema can drift. v0 needs one authoritative schema before more durable workflow state is added.
**How**: Add Drizzle Kit configuration, align the existing schema with the current migration, generate the baseline migration from schema, and add a check that fails when schema and generated migrations drift.

**Test plan**: `corepack pnpm run format:check`, `corepack pnpm run lint`, schema drift check, migration tests, `corepack pnpm run check`.
**Quality bar**: Runtime migration code applies committed migrations only; generated SQL is reviewable; no duplicate source of truth remains.
**Real-functionality validation**: Fresh Postgres container migrates from generated migration output and the hello-world CLI smoke still passes.
**Version verification**: `drizzle-kit@0.31.10` verified on 2026-05-21 with the npm registry; tarball source `https://registry.npmjs.org/drizzle-kit/-/drizzle-kit-0.31.10.tgz`. Existing `drizzle-orm` lockfile version `0.45.2` was confirmed current via the npm registry on the same date.
**Migration compatibility**: This clean hello-world baseline may require resetting existing local Postgres volumes after replacing the hand-written baseline migration with the generated Drizzle baseline. No compatibility shim is required before real data exists.
**Worktree-isolation safety**: This spec exclusively writes database schema, migration tooling, and migration-related architecture docs.

### SPEC-0002 - local-runner-ssh-substrate

**Owns**: `services/orchestrator/src/engine/contracts/sshSubstrate.ts`, `services/orchestrator/src/engine/ssh/**`, `services/orchestrator/tests/**ssh**`, `runner/**` only when SSH server behavior requires it.
**Consumes**: SPEC-0001.
**Produces**: a real SSH execution contract for runner commands.

**What**: Implement an SSH substrate that can execute commands in the runner container and return exit code, stdout, stderr, and timeout/failure information.
**Why**: `PROJECT_BRIEF.md` requires agent workloads to run through SSH, not direct Docker command execution.
**How**: Add a real SSH client implementation behind the existing `SshSubstrate` interface, preserve fake substrate tests, and add integration smoke against the local runner.

**Test plan**: unit tests for command result and failure mapping, integration smoke for `echo hello` over SSH, `corepack pnpm run check`.
**Quality bar**: No workload path imports `child_process`; command failures become declared Tanren failures; SSH execution does not require host worktree mounts.
**Real-functionality validation**: Orchestrator-side code can run a command in the runner and persist or report the observed output.
**Worktree-isolation safety**: This spec owns SSH substrate files and only touches runner files if needed for SSH behavior.

### SPEC-0003 - local-docker-allocator

**Owns**: `services/orchestrator/src/engine/contracts/allocator.ts`, `services/orchestrator/src/engine/allocators/**`, `services/orchestrator/tests/**allocator**`, `db/src/schema.ts` and migrations only for runner metadata changes.
**Consumes**: SPEC-0002.
**Produces**: a local allocator contract that records and releases runner allocations.

**What**: Replace the fake allocator path with a local Docker allocator suitable for the development compose stack.
**Why**: The workflow needs a concrete allocation lifecycle before real workspace and agent execution can be trusted.
**How**: Allocate the existing runner service or a per-run runner container, record runner metadata in Postgres, expose release semantics, and keep workload execution routed through SSH.

**Test plan**: allocator unit tests, compose smoke for allocation and release, architecture checks for no direct Docker workload path, `corepack pnpm run check`.
**Quality bar**: Allocator lifecycle code is the only permitted Docker-control surface; workload commands still use SSH; runner rows accurately describe active/released state.
**Real-functionality validation**: A hello-style run can allocate a local runner, connect through SSH, and release it.
**Worktree-isolation safety**: This spec owns allocator implementation and runner metadata changes.

### SPEC-0004 - hello-over-ssh

**Owns**: `services/orchestrator/src/engine/workflow/**`, `services/orchestrator/src/main.ts`, `services/orchestrator/src/engine/events.ts`, `services/orchestrator/tests/**hello**`, `.github/workflows/ci.yml` and `compose.yml` only for hello SSH smoke wiring, `cli/src/main.ts` only for output shape, `services/dashboard/src/main.tsx` only for displaying new hello events.
**Consumes**: SPEC-0003.
**Produces**: the current hello workflow executed across the real runner boundary.

**What**: Extend hello-world so at least one workflow step executes over SSH in the allocated runner.
**Why**: This is the smallest meaningful proof that Tanren's persisted workflow uses the same execution boundary real agents will use.
**How**: Allocate a runner, execute a deterministic command over SSH, append declared events for allocation/execution/release, and expose the result through CLI status and dashboard run views.

**Test plan**: hello workflow tests, CLI smoke for `doctor`, `hello`, and `status`, compose smoke with runner SSH, `corepack pnpm run check`.
**Quality bar**: The synthetic workflow remains understandable, but execution proof now crosses the real runner boundary.
**Real-functionality validation**: `tanren hello` persists SSH output from the runner and `tanren status <run_id>` shows the runner events.
**Worktree-isolation safety**: This spec owns hello workflow surfaces and minimal CLI/dashboard display changes.

### SPEC-0005 - workspace-git-contract

**Owns**: `services/orchestrator/src/engine/workspace/**`, `services/orchestrator/src/engine/providers/fake.ts`, `services/orchestrator/src/engine/providers/types.ts`, `services/orchestrator/src/engine/workflow/**`, `services/orchestrator/src/engine/events.ts`, `services/orchestrator/tests/**workspace**`, `services/orchestrator/tests/**fakeProviders**`, `services/orchestrator/tests/**hello**`, `fixtures/**`, `runner/**` only for workspace prerequisites.
**Consumes**: SPEC-0004.
**Produces**: a stable runner workspace and git mutation contract for Writer tasks.

**What**: Make the fake writer operate on a real git workspace in the runner instead of returning a synthetic diff string.
**Why**: Writers are judged by workspace mutation, so Tanren must capture real git state before adding real CLIs.
**How**: Define workspace layout, clone or initialize a fixture repo in the runner, run fake writer commands over SSH, create a real commit or diff, and capture commit metadata plus diff for checker/auditor input.

**Test plan**: workspace unit tests, fake writer integration smoke, git diff/commit capture tests, `corepack pnpm run check`.
**Quality bar**: Writer result derives from git state, not self-reported completion text; no host worktree or host credential is mounted into the runner.
**Real-functionality validation**: Hello creates or modifies a file in a runner git workspace and persists the captured diff/commit metadata.
**Worktree-isolation safety**: This spec owns workspace code, fake provider behavior, fixtures, and runner workspace prerequisites.

### SPEC-0006 - durable-run-task-loop

**Owns**: `services/orchestrator/src/engine/contracts/jobQueue.ts`, `services/orchestrator/src/engine/workflow/**`, `services/orchestrator/src/engine/events.ts`, `services/orchestrator/src/main.ts`, `cli/src/main.ts`, `db/src/schema.ts` and migrations only for lifecycle columns/indexes.
**Consumes**: SPEC-0005.
**Produces**: a durable run/spec/task lifecycle that can later host real planner, writer, checker, and auditor tasks.

**What**: Move the hello workflow from a single synchronous operation toward a durable task loop with persisted state transitions.
**Why**: v0 requires planner, writer, checker, auditor, PR, CI, review, and merge loops to resume from durable state instead of process memory.
**How**: Implement queue-backed or database-claimed task progression for the fake workflow, normalize task statuses/outcomes, emit declared lifecycle events, and add CLI visibility into queued/running/done states.

**Test plan**: lifecycle unit tests, queue/claim tests, CLI status tests, failure-state tests, compose smoke, `corepack pnpm run check`.
**Quality bar**: Every state transition is persisted; events remain append-only through `eventStore.ts`; the workflow can be inspected without reading process logs.
**Real-functionality validation**: A hello run progresses through persisted planner, writer, checker, and auditor task states and reaches done after real runner workspace mutation.
**Worktree-isolation safety**: This spec owns workflow lifecycle code, job queue contract, event names, lifecycle CLI output, and any required lifecycle schema changes.

## Phase 0 Exit Criteria

Phase 0 is complete. The following exit criteria were verified on merged `main` on 2026-05-22:

- `db/src/schema.ts` is the single source of truth and generated migrations are drift-checked.
- The orchestrator executes workflow commands over SSH in a runner.
- The local allocator records and releases runner allocations.
- `tanren hello` crosses the runner SSH boundary.
- The fake writer mutates a real git workspace in the runner.
- The orchestrator captures real diff/commit metadata for checker/auditor use.
- Spec, run, and task state transitions are durable enough for later async real-agent work.
- `corepack pnpm run check` passes.
- Compose smoke proves CLI `doctor`, `hello`, `status`, and runner SSH.

Final Phase 0 verification:

- `corepack pnpm run check`
- `just smoke`
- GitHub Actions on `main` SHA `eebbf2aedca77fd205ceab0f56736a6c571afc7d`
- Smoke run output showed run status `done`, ordered planner/writer/checker/auditor tasks all `done`, `workspace.git_captured` with real commit metadata and diff byte count, runner SSH output `tanren-runner-ok`, and the live SSH integration test passing.

## Phase 1: Real-Agent PR Loop

Status: complete and live-proven on `main`.

Phase 1 kept the Phase 0 local runner and durable task loop, then replaced synthetic edges with real project, credential, agent, GitHub, and CI behavior. It ended with Tanren taking a persisted spec for an owned fixture repository, running a real Codex Writer in a runner workspace, using structured Codex Answerers for check/audit, producing a draft PR, observing CI, and making the run inspectable through durable state.

Mergify stacks are the default branch/PR coordination model for dependent work. Merge queue remains deferred until PR volume or CI latency makes queueing useful.

Phase 1's first real CLI is Codex. This is intentionally narrower than the full v0 provider set: v0 still needs Codex, Claude, and opencode as Writer CLIs, and Codex plus Claude as Answerers. opencode remains Writer-only for v0 because it does not provide native JSON-schema enforcement strong enough for the Answerer role.

Codex planning assumptions were checked against OpenAI's Codex docs and the locally installed `codex` CLI on 2026-05-22:

- Codex CLI can be installed with `npm i -g @openai/codex`, runs locally in a terminal, and can inspect/edit/run code in the selected directory: `https://developers.openai.com/codex/cli`.
- Codex CLI authentication supports ChatGPT sign-in and API-key sign-in; ChatGPT sign-in is the default path for the CLI when no valid session is available: `https://developers.openai.com/codex/auth`.
- Codex CLI command reference documents `codex exec` for non-interactive runs, `--sandbox workspace-write`, `--json` JSONL events, `--output-schema`, and `codex login` with `--device-auth`, `--with-access-token`, and `--with-api-key`: `https://developers.openai.com/codex/cli/reference`.
- Device auth is a normal ChatGPT OAuth login mode for Codex CLI and does not require ChatGPT Business or Enterprise. It is suitable for credential bootstrap/onboarding, not for every runner launch.
- Codex access tokens are separate from device auth, are supported for ChatGPT Business and Enterprise workspaces, and are intended for trusted non-interactive local workflows that need ChatGPT workspace identity; Platform API keys remain the simpler automation credential when ChatGPT workspace access is not needed: `https://developers.openai.com/codex/enterprise/access-tokens`.

### Phase 1 Dependency Graph

```text
P1-0001 project-spec-contract
  -> P1-0002 vault-credential-session
  -> P1-0004 github-draft-pr-contract

P1-0002 vault-credential-session
  -> P1-0003 real-writer-cli-adapter
  -> P1-0004 github-draft-pr-contract
  -> P1-0006 answerer-check-audit-loop

P1-0003 real-writer-cli-adapter
  -> P1-0006 answerer-check-audit-loop

P1-0004 github-draft-pr-contract
  -> P1-0005 ci-polling-loop

P1-0003 real-writer-cli-adapter +
P1-0004 github-draft-pr-contract +
P1-0005 ci-polling-loop +
P1-0006 answerer-check-audit-loop
  -> P1-0007 phase1-end-to-end-fixture
```

Dependency shape:

```text
project/spec input
  -> credentials -> real Writer -> real Answerer checks
  -> credentials -> GitHub draft PR -> CI polling

real Writer + GitHub PR + CI polling + Answerer checks/audit
  -> end-to-end fixture
```

### P1-0001 - project-spec-contract

**Owns**: `db/src/schema.ts`, `db/migrations/**`, `services/orchestrator/src/engine/workflow/**`, `services/orchestrator/src/main.ts`, `cli/src/main.ts`, tests covering project/spec/run creation.
**Consumes**: Phase 0 durable run/task loop.
**Produces**: persisted project, repo, target branch, and spec input contract.

**What**: Replace hard-coded hello project/spec inputs with a minimal persisted project/spec contract that can target an owned fixture repository.
**Why**: Real PR automation needs a repo URL, target branch, spec acceptance criteria, and run identity from data rather than constants.
**How**: Add CLI/API input for creating or selecting a project/spec, preserve the hello path as a smoke fixture, and ensure run creation consumes persisted spec data.

**Test plan**: schema drift, CLI/API tests, workflow tests, `corepack pnpm run check`.
**Quality bar**: no hidden constants for repo URL or branch in the real workflow path; hello remains an explicit fixture.
**Real-functionality validation**: a run can be created from a persisted spec targeting a fixture repo.
**Worktree-isolation safety**: owns project/spec input surfaces only; does not add real CLIs or GitHub PR writes.

### P1-0002 - vault-credential-session

**Owns**: credential contracts, Vault-backed secret store, runner credential materialization helpers, related tests and docs.
**Consumes**: P1-0001.
**Produces**: per-run credential loading from Vault into runner sessions, starting with Codex ChatGPT auth.

**What**: Move from in-memory runner identity seeding toward a real credential/session contract for GitHub and Codex credentials.
**Why**: `PROJECT_BRIEF.md` forbids host credential discovery and requires credentials to be managed and injected per session.
**How**: Store credential references in project/run config, read values from Vault, transfer only required session material to the runner over the controlled SSH boundary, and redact values from logs/events. For Codex, the Phase 1 primary credential path is ChatGPT-managed auth, not API-key auth. Onboarding should support a one-time `codex login --device-auth` or equivalent browser/device flow, then store the resulting Codex auth bundle, such as the managed `auth.json` contents, in Vault for later runner provisioning. Runner launch must not require an interactive device login; provisioning materializes the stored credential bundle into a per-run `CODEX_HOME` before `codex exec`, and refreshed cached auth is written back to the managed ref when possible. Business/Enterprise access-token auth through `codex login --with-access-token` is a separate future enterprise/programmatic mode, not the base Phase 1 requirement. API-key auth remains a fallback for tests and generic programmatic automation where ChatGPT workspace identity is not needed.

**Test plan**: secret-store unit tests, redaction tests, runner materialization tests, Codex auth materialization tests, compose smoke with runner identity.
**Quality bar**: no `~/.codex` or `~/.config` host discovery, no host credential bind mounts, no secret values in events, no assumption that enterprise access tokens are available unless explicitly configured.
**Real-functionality validation**: runner can use a Vault-backed Codex credential in a fresh per-run `CODEX_HOME` without repeating interactive device auth for every container launch.
**Worktree-isolation safety**: owns credential/secret surfaces; does not own agent adapter behavior.

### P1-0003 - real-writer-cli-adapter

**Owns**: Writer adapter contracts, runner command wrappers, fake-to-real adapter tests, fixture writer smoke.
**Consumes**: P1-0001 and P1-0002.
**Produces**: a real Writer CLI path that mutates the runner workspace and is judged by git state.

**What**: Add the first real Writer CLI adapter behind the Phase 0 writer contract.
**Why**: The next proof after fake git mutation is a real CLI making the mutation while the orchestrator still evaluates only workspace state.
**How**: Start with Codex CLI as the first Writer. Run `codex exec` over SSH in the runner workspace with explicit automation settings, including `--sandbox workspace-write`, per-run `CODEX_HOME`, and `--json` so the orchestrator can persist JSONL events and any emitted usage fields. Capture timeout/failure, restore refreshed `auth.json` to the managed credential ref when available, and keep completion based on git diff/commit capture rather than stdout. Claude and opencode Writer adapters are v0 follow-ups after the Codex contract is proven.

**Test plan**: adapter command construction tests, failure tests, opt-in live smoke for the configured CLI, `corepack pnpm run check`.
**Quality bar**: Writer does not self-report done; no host execution; no credential leakage.
**Real-functionality validation**: a real CLI changes a fixture repo workspace in the runner and the orchestrator captures the resulting diff.
**Worktree-isolation safety**: owns Writer adapter surfaces; does not own GitHub PR creation.

### P1-0004 - github-draft-pr-contract

**Owns**: GitHub service contracts, PR event names, project repo auth usage, workspace push/branch helpers, tests.
**Consumes**: P1-0001 and P1-0002.
**Produces**: draft PR creation for a completed writer workspace.

**What**: Push the runner workspace branch to GitHub and open a draft PR against the project target branch.
**Why**: v0's workflow product requires code to leave the runner as a reviewable PR, not just a captured diff.
**How**: Use a managed GitHub credential, create a deterministic branch name, push commits from the runner workspace, create a draft PR, and persist the PR URL and GitHub events.

**Test plan**: branch naming tests, API contract tests with fakes, opt-in fixture repo smoke, `corepack pnpm run check`.
**Quality bar**: PR creation is idempotent for retry; no direct host git push; run state records PR URL.
**Real-functionality validation**: a fixture repo receives a draft PR produced from runner workspace commits.
**Worktree-isolation safety**: owns GitHub PR creation; does not own CI polling.

### P1-0005 - ci-polling-loop

**Owns**: CI status polling contracts, run/task states for CI, GitHub status event handling, tests.
**Consumes**: P1-0004.
**Produces**: durable CI observation and loop routing after PR creation.

**What**: Poll GitHub check status for the created PR and persist pass/fail state.
**Why**: The workflow must make CI status a durable gate before review/merge decisions.
**How**: Add a CI task/job kind, poll checks for the PR head, persist `ci.started`, `ci.passed`, or `ci.failed`, and route failures back to the planner path in later specs.

**Test plan**: fake GitHub status tests, retry/backoff tests, status visibility tests, `corepack pnpm run check`.
**Quality bar**: no process-memory-only CI state; failed CI is inspectable and resumable.
**Real-functionality validation**: fixture PR CI status is persisted and visible from `tanren status`.
**Worktree-isolation safety**: owns CI polling surfaces only.

### P1-0006 - answerer-check-audit-loop

**Owns**: Answerer adapter contracts, structured response schemas, check/audit task execution, validation tests.
**Consumes**: P1-0002 and P1-0003.
**Produces**: real structured Answerer checks for writer output and spec completion.

**What**: Replace fake checker/auditor answers with structured Answerer calls while preserving the Writer/Answerer split.
**Why**: Real writers need external verification before PR/CI/review gates can be trusted.
**How**: Define schemas for check and audit answers, call Codex first over the controlled credential path using `codex exec --output-schema`, validate responses, and persist parse failures as task failures. Claude is the second v0 Answerer target. opencode is explicitly out of the v0 Answerer path until a separate client-side schema-validation contract exists.

**Test plan**: schema validation tests, parse failure tests, fake answerer tests, opt-in live Answerer smoke.
**Quality bar**: Answerers never mutate the workspace; invalid JSON is a hard task failure.
**Real-functionality validation**: a real Answerer judges a fixture writer diff and audit criteria.
**Worktree-isolation safety**: owns Answerer execution and schema surfaces.

### P1-0007 - phase1-end-to-end-fixture

**Owns**: end-to-end fixture, final Phase 1 smoke, roadmap validation docs.
**Consumes**: P1-0003, P1-0004, P1-0005, and P1-0006.
**Produces**: the first real-agent PR loop proof.

**What**: Tie the Phase 1 contracts into one fixture workflow.
**Why**: Phase 1 is only complete when the real-agent pieces work together, not just in isolated tests.
**How**: Run a persisted spec against an owned fixture repo, invoke a real Writer CLI, create a draft PR, poll CI, run real or configured Answerer checks/audit, and persist the complete run.

**Test plan**: `corepack pnpm run check`, `just smoke`, opt-in live fixture workflow.
**Quality bar**: every boundary is inspectable through durable state; no hidden host execution or host credential use.
**Real-functionality validation**: a fixture GitHub PR exists with runner-produced commits and persisted CI/check/audit state.
**Live validation command**: with compose Postgres, Vault, and runner running, use `TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json TANREN_GITHUB_TOKEN_FILE=/path/to/token TANREN_GITHUB_REPO_URL=https://github.com/cat-cave/tanren-fixture-easy just live-phase1-fixture`.
**Completion evidence**: the live fixture must leave a persisted run with `outcome = 'phase1_fixture_complete'`, a draft PR URL, and `plan`, `write`, `check`, `audit`, and `ci` tasks all `done`.
**Current live proof**: using compose Vault for credential storage, run `run_a347d451-3911-470d-b506-280b602343a9` completed with `outcome = 'phase1_fixture_complete'`, all five required tasks `done`, and draft fixture PR `https://github.com/cat-cave/tanren-fixture-easy/pull/6` passing CI. The event log recorded `runner.allocated`, `workspace.prepared`, `workspace.git_captured`, `checker.completed`, `auditor.completed`, `github.pr.created`, `ci.passed`, `phase1.fixture.completed`, and `runner.released`.
**Worktree-isolation safety**: owns integration wiring only; upstream contracts must be stable before this starts.

### Phase 1 Parallelization Plan

Start sequentially through P1-0001 and P1-0002 because they define shared data and credential contracts. After P1-0002 is merged, fan out with Mergify stacks:

- Stack A: P1-0003 real Writer adapter.
- Stack B: P1-0004 GitHub draft PR contract.
- Stack C: P1-0006 Answerer schema/execution contract.

P1-0005 depends on P1-0004 and can begin as soon as the PR contract is stable. P1-0007 stays last and should not start until the preceding contracts are merged or stacked cleanly with green CI.

### Phase 1 Prep Notes

- Use Mergify stacks for dependent PRs; do not use manual chain retargeting unless stack tooling is unavailable.
- Keep each stack short and self-contained. Independent specs should use separate stacks rather than one long chain.
- Merge queue remains deferred until PR volume or CI wait time makes queueing useful.
- The beta design system should be pulled in when Phase 1 adds user-visible workflow state beyond the current dashboard table. Until then, keep backend/workflow specs generic and preserve UI integration as a separate owned path.
- Remote/cloud allocators remain a later phase unless a Phase 1 live CLI provider cannot be validated in the local runner.
- Do not start Phase 1 by trying to support every provider. Prove Codex first with ChatGPT-managed auth imported as a managed auth bundle, `codex exec`, durable event capture, allowed cost/usage attribution, and git-state-based Writer completion. Treat Codex access-token auth as a future enterprise/programmatic credential mode. Then add Claude and opencode as additional Writer implementations, and Claude as the second Answerer implementation before v0 completion.

### Phase 1 Closeout Notes

- Phase 1 stacked PRs worked well for reviewability and per-spec CI boundaries.
- Manual stack merging did not work cleanly: after the first stacked PR was squash-merged, remaining PRs did not automatically retarget cleanly and required rebasing/replacement PRs.
- Future stacks should stay short, contain only true dependencies, and be managed through `mergify stack sync` and `mergify stack push`.
- Independent specs should be separate stacks so they can merge without dragging a long dependent chain.
- Stack PR lifecycle policy must stay explicit. If the repo keeps the current Mergify skill guidance, stack PRs remain drafts until the user manually marks them ready; if Tanren wants agents to mark ready-for-review, update the stack instructions first.

## Phase 2: Operator-Controlled Workflow

Status: 2A complete (all P2A specs merged; easy tier live-proven, medium mechanism live-proven). 2B in progress — hi-fi handoff imported at `tanren-hi-fidelity/`, building from P2B-0001 (shell). Execution plan + session decision log: [`docs/roadmap/phase-2b-execution-plan.md`](docs/roadmap/phase-2b-execution-plan.md). Scoped 2026-05-27 against `docs/audits/phase2-readiness.md`; re-scoped 2026-05-28 against the hi-fi vision artifact (`tanren-hi-fidelity` bundle).

Phase 2 turns the live Phase 1 proof from an opt-in test harness into an operator-controlled product surface that matches a defined subset of the hi-fi long-term vision. The end state is that an operator can register a GitHub org as a Tanren tenant, link a repo, configure credentials and routing, submit a spec, run the real workflow, recover from failure, and view the resulting PR — all through the dashboard with no CLI or DB access.

Phase 2 is split into 2A (operator backend and contracts, no user-visible UI changes) and 2B (operator dashboard and the first operator-driven live run). Design tokens are imported at the 2A→2B boundary; hi-fi screens must be locked per surface before each 2B spec begins.

The hi-fi is treated as a **vision artifact** depicting the long-term product. Phase 2 ships a defined subset of it. ROADMAP carries the phasing; the hi-fi is not phase-tagged by ROADMAP. Items present in the hi-fi but deferred from Phase 2 are named explicitly in the "Phase 2 scope against the hi-fi" subsection and again in Phase 3.

### Phase 2 Decision Record

The following ground rules were locked between 2026-05-27 and 2026-05-28 and shape every spec below:

- Multi-user authentication from day one with **organization** as the top-level tenant (= GitHub org). GitHub OAuth is the first identity provider; an OIDC provider interface (Authentik first) is prepared even though Authentik does not ship in Phase 2.
- Redaction is raw-stored and applied on read against actor access scope; the event log is treated as a compliance substrate.
- Zod is the single source of truth for workflow state, project config, event payloads, Answerer schemas, and the product-entity model (organizations, projects, personas, behaviors, milestones, spec dependencies).
- Dev and prod compose profiles are split; prod requires operator-provided Vault and Postgres secrets and publishes only the dashboard.
- The acceptance gate runs locally via `just acceptance`; live Codex/GitHub credentials never enter GitHub Actions secrets.
- Cost persistence is mandatory; unattributable usage fails the task. No unknown-source rows.
- The v0 routing table has **six roles**: plan, write, check, audit, demo, forge. All except `write` use the Answerer interface. Routing is stored as a per-role fallback chain `(cli, model, authRef)[]`, even when v0 has only Codex entries — the schema does not change when Claude and opencode arrive in Phase 3.
- **Forge** is an Answerer role with broader read scope (cross-spec + target repo + Tanren DB) and conversation-mode invocation. Phase 2 ships its data substrate (turns table, tool schema, read-only tool stubs, a small set of operator-actionable write buttons) but not an LLM-driven conversation backend.
- **demo** is a legitimate Answerer role (spec-completion narration for review). Phase 2 ships its schema and a templated v0 generator.
- **Config bucketing is principled**: artifacts that GitHub or Mergify reads (`.github/workflows/tanren-ci.yml`, `.mergify.yml`, `CODEOWNERS`) live in the target repo with the target repo as source of truth; everything else (routing, retry budgets, notifications matrix, allocator selection, Vault refs, personas, behaviors, milestones, governance posture, Forge persona) lives in the orchestrator DB. No two-way sync. Phase 2 writes config to DB only; Phase 3 introduces the optional `tanren-config` repo audit gate and the brownfield config-injection PR pattern (which generates a one-time `.tanren/PROJECT.md` snapshot, not an ongoing mirror).
- Review and merge loops remain Phase 3; the Phase 2 review surface displays state and supports behavior verification, but its sign-off CTAs reflect "merge integration is configurable per-repo and not yet wired" rather than acting on the PR.
- Notifications matrix schema is full (per-event × per-channel × severity, with dev-layered overrides on org defaults); v0 implementation only wires ntfy. Slack and GitHub Checks ship in Phase 3.
- Codex remains the only working provider in Phase 2 (Writer, Answerer, Planner, demo generator, forge stub generator). Claude and opencode arrive in Phase 3.

### Phase 2 Dependency Summary

Phase 2A has six work groups; full ASCII dependency graphs are in [`docs/roadmap/phase-2a-specs.md`](docs/roadmap/phase-2a-specs.md) and [`docs/roadmap/phase-2b-specs.md`](docs/roadmap/phase-2b-specs.md).

- **Foundation (sequential, blocks everything)**: P2A-0001 → P2A-0002.
- **Security stack**: P2A-0003 → P2A-0004.
- **Typed-contracts stack**: P2A-0005 → P2A-0018 → (P2A-0006 ∥ P2A-0007 ∥ P2A-0008).
- **Runtime stack**: P2A-0009 (after 0003 + 0007), P2A-0010 (after 0004 + 0005), P2A-0011 (after 0005 + 0007), P2A-0017 (after 0006 + 0007 + 0011).
- **Workflow stack**: P2A-0012 (after 0005 + 0008 + 0011) → P2A-0019 → P2A-0020.
- **Product API stack**: P2A-0013 (after 0003 + 0006 + 0018), P2A-0014 (after 0005 + 0007 + 0009 + 0011 + 0019 + 0020 + 0002).
- **Closeout + boundary**: P2A-0015 acceptance gate closes 2A; P2A-0016 tokens land at the 2A→2B boundary.

Phase 2B fans out from P2A-0016 + P2A-0003 into P2B-0001 (shell), which gates P2B-0002…0005 + P2B-0008 + P2B-0009 in parallel. P2B-0006 (operator-triggered live workflow) requires P2B-0002 + P2B-0003 + P2B-0004 + P2B-0008 + P2A-0015. P2B-0007 (demo) closes Phase 2.

### Phase 2 Workflow Inventory

Locked in P2A-0002 against the hi-fi vision. Phase 2B may not ship a screen whose acceptance criteria are not artifacted under `docs/design/acceptance-criteria/**` ([README](docs/design/acceptance-criteria/README.md)). Each row names the hi-fi surface, the owning Phase 2B spec, and any reductions from the hi-fi as-shown:

- **Shell + ⌘K palette**: top bar (org pill, project crumb, ink/ash, ⌘K, notifications), sidenav (org/projects/setup/onboarding groups). Owned by P2B-0001. Reductions: org/personas/DORA sidenav rows ship as labeled placeholders (Phase 3).
- **Onboarding · org setup** (hi-fi 01a, 4 steps): GitHub org link, credentials (org+dev), notifications, infrastructure (allocator + budgets). Owned by P2B-0002. Reductions: cloud allocators are visual stubs (Phase 4+); infrastructure step shows local-docker only in v0; the "label → allocator routing" future-panel stays as a phase-tagged stub.
- **Onboarding · existing project (minimal)** (hi-fi 01c, subset): step 1 link-repo + a thin project-config form replacing steps 2–5. Owned by P2B-0002. Reductions: brownfield recon agent, config-injection PR, agent-gap analysis, governance-posture picker, codeowners scaffold all defer to Phase 3.
- **Onboarding · greenfield new project (stretch)** (hi-fi 01b, thin): step 1 a basic project-create form (title, description, repo, behaviors as free-text). Owned by P2B-0009. Reductions: the full Forge interview, derived spec DAG, sources/audits/arrival pages defer to Phase 3.
- **Project view · chat-primary** (hi-fi 03 chat mode): Forge attention queue + suboptimal callouts (retry hotspot, model mismatch, pace anomaly) + activity feed + velocity card. Owned by P2B-0003. Reductions: dag-primary mode (full DAG canvas, milestones, behavior badges) defers to Phase 3; "stuck" and "review stall" callouts defer (require DAG dependency chain + review polling).
- **Run detail** (hi-fi 05): cost bar (4 sources), trajectory spine with planner subtasks, writer's reasoning (intent + BDD + tool calls + decisions). Owned by P2B-0004. Reductions: live preview deploy pane (Phase 3); subscription-window heatmap is not shown here (lives in costs).
- **Review handoff** (hi-fi 06): behaviors checklist, deferrals resolution, preview pane, readiness gate. Owned by P2B-0004 sub-surface. Reductions: sign-off CTAs render as "merge integration · configurable per-repo · not wired in v0"; live preview-deploy iframe defers to Phase 3.
- **Failure recovery** (hi-fi 07): halted-run page with 4 recovery cards (revise spec, replan with steering, rollback, open inspection thread) + DAG impact strip. Owned by P2B-0008. Reductions: DAG impact strip renders as a flat list of downstream-blocked specs (no DAG layout) until Phase 3.
- **Settings · routing & limits** (hi-fi 08): 6-role × fallback-chain UI, Vault per-cred policy list, escape hatches, Forge config edit prompt. Owned by P2B-0003 sub-surface. Reductions: only Codex-bound chain rows are functional in v0; "edits land as a pr" is conditional on the org's audit-gate setting which defaults off in Phase 2.
- **History & costs** (hi-fi 09): total spend stacked bar (4 sources), provider breakdown table, burn projection, subscription-window headroom panel. Owned by P2B-0005. Reductions: subscription-window utilization heatmap and DORA panel defer to Phase 3.
- **Spec discovery** (hi-fi 02): defers to Phase 3 entirely (requires thick Forge + full DAG + behaviors).
- **Notifications matrix** (within hi-fi 01a step 3): per-event × per-channel × severity matrix UI. Owned by P2B-0002. Reductions: only ntfy is implementable in v0; slack/github-checks render as "configured but not yet wired" stubs; teams/discord/email/twilio/pagerduty/webhook render as phase-badged future channels (already done in hi-fi).

### Phase 2 Prep Notes

- The hi-fi (`tanren-hi-fidelity` bundle, May 2026) is the long-term product vision and is not phase-tagged by this ROADMAP. Vision-level changes to the hi-fi are tracked separately in `docs/design/hifi-vision-changes.md`; phase-tagging happens here, not in the hi-fi.
- Design tokens land in P2A-0016 at the 2A→2B boundary. Hi-fi screens must be locked per surface before each 2B spec begins; no global dashboard restyle in the import spec.
- Phase 2A is the largest contract block this project has scoped (20 specs). Mergify stacks must stay short and self-contained; the parallelization plan below identifies the five independent swimlanes.
- Real review and merge loops (PROJECT_BRIEF §2.1 steps 9–11) are Phase 3, not Phase 2B. The hi-fi review readiness gate is repo-configurable in the long-term vision; Phase 2 ships the CTAs as `merge integration · not wired in v0`.
- Provider expansion (Claude Writer, Claude Answerer, opencode Writer with Zai GLM 5.1) is Phase 3. Wafer pass-through through opencode was discontinued on 2026-05-27 and no longer appears in any Phase 2, Phase 3, or hi-fi plan; PROJECT_BRIEF §3.1 still references it and is amended at Phase 3 entry.
- Remote allocators (Hetzner, manual-SSH) remain Phase 3.
- Brownfield onboarding ships its "minimal existing" form in Phase 2: link the repo + fill a project-config form. Brownfield recon agent, agent-gap analysis, config-injection PR (which generates a one-time `.tanren/PROJECT.md` snapshot as a transparency artifact), and codeowners scaffolding all defer to Phase 3.
- Greenfield onboarding ships only as a stretch goal in Phase 2 and only in a thin form (no Forge interview). The full multi-round vision interview, derived spec DAG, and sources/audits/arrival surfaces are Phase 3.
- All Phase 2A schema migrations are destructive against existing local dev data. The Phase 1 live proof (`run_a347d451…`) is preserved as a ROADMAP record, not as a preserved DB row.
- Use `docs/audits/phase2-readiness.md` as the audit reference. Every audit critical and high finding is owned by a Phase 2A spec, with the exception of review/merge implementation (Phase 3), required-check awareness (Phase 3), queue lease recovery (Phase 3), latency observability (Phase 3), and coverage thresholds (Phase 3).

Detailed Owns / Consumes / Produces / What / Why / How / Test plan / Quality bar / Real-functionality validation / Worktree-isolation safety entries for each P2A spec are in [`docs/roadmap/phase-2a-specs.md`](docs/roadmap/phase-2a-specs.md).

| Spec     | Title                            | Notes                                                                            |
| -------- | -------------------------------- | -------------------------------------------------------------------------------- |
| P2A-0001 | phase1-closeout-docs             | Operator-readable Phase 1 closeout.                                              |
| P2A-0002 | phase2-workflow-inventory        | Lock low-fi wireframes + acceptance criteria per surface.                        |
| P2A-0003 | operator-auth-control-plane      | Orgs + users + GitHub OAuth + OIDC interface.                                    |
| P2A-0004 | dev-prod-compose-split           | `compose.dev.yml` and `compose.prod.yml` profiles.                               |
| P2A-0005 | typed-workflow-state-contract    | Zod discriminated unions for run/spec/task/job/actor state.                      |
| P2A-0006 | versioned-project-config         | 6-role × fallback-chain routing; org + project config.                           |
| P2A-0007 | event-payload-schemas            | Semantic-rich event payloads for Forge narration.                                |
| P2A-0008 | answerer-schema-single-source    | Zod source for all 5 Answerer roles (plan/check/audit/demo/forge).               |
| P2A-0009 | redaction-access-scope           | Raw-stored, redact-on-read by actor scope.                                       |
| P2A-0010 | runner-allocator-isolation       | Allocator sidecar; ephemeral runners; workspace + auth cleanup.                  |
| P2A-0011 | cost-record-persistence          | Mandatory attribution; no unknown-source rows.                                   |
| P2A-0012 | planner-feedback-loops           | Real Planner subtasks; checker + auditor rejection loops.                        |
| P2A-0013 | project-spec-cli-api             | Orgs/projects/specs/behaviors/milestones/credentials CRUD + `/doctor`.           |
| P2A-0014 | run-detail-api-contract          | Read API the dashboard consumes; SSE, pagination, redaction.                     |
| P2A-0015 | executable-acceptance-gate       | `just acceptance-easy` and `just acceptance-medium`.                             |
| P2A-0016 | design-system-import             | Tokens land at the 2A→2B boundary; no restyle.                                   |
| P2A-0017 | notifications-contract           | Full event×channel×severity matrix schema; ntfy-only impl.                       |
| P2A-0018 | product-entities-contract        | Personas / behaviors / milestones / spec-dependency edges.                       |
| P2A-0019 | forge-narration-and-tool-surface | Threads + turns + tool schema + read-only stubs + operator-button write actions. |
| P2A-0020 | workflow-insights-contract       | `retry_hotspot`, `model_mismatch`, `pace_anomaly` insights.                      |

### P2A Parallelization Plan

After P2A-0001 and P2A-0002 land, five independent swimlanes proceed in parallel as Mergify stacks:

- **Security stack**: P2A-0003 then P2A-0004.
- **Typed-contracts stack**: P2A-0005, P2A-0018, P2A-0006, P2A-0007, P2A-0008 (P2A-0005 first; P2A-0018 next; the rest fan out).
- **Runtime stack**: P2A-0009 (after P2A-0003 + P2A-0007), P2A-0010 (after P2A-0004 + P2A-0005), P2A-0011 (after P2A-0005 + P2A-0007), P2A-0017 (after P2A-0007 + P2A-0011 + P2A-0006).
- **Workflow stack**: P2A-0012 (after P2A-0005, P2A-0008, P2A-0011), then P2A-0019 (after P2A-0006 + P2A-0007 + P2A-0008 + P2A-0011 + P2A-0018), then P2A-0020 (after P2A-0007 + P2A-0011 + P2A-0012).
- **Product API stack**: P2A-0013 (after P2A-0003 + P2A-0006 + P2A-0018), P2A-0014 (after P2A-0005 + P2A-0007 + P2A-0009 + P2A-0011 + P2A-0019 + P2A-0020 + P2A-0002).

P2A-0015 (acceptance gate) closes 2A and requires the workflow and product API stacks complete. P2A-0016 (design tokens) ships independently and lands at the 2A→2B boundary.

Phase 1's closeout note that manual stack merging did not work cleanly applies here: Mergify stacks must be managed through `mergify stack sync` and `mergify stack push`, and independent specs must live on separate stacks.

Detailed entries for each P2B spec are in [`docs/roadmap/phase-2b-specs.md`](docs/roadmap/phase-2b-specs.md).

| Spec     | Title                                | Notes                                                          |
| -------- | ------------------------------------ | -------------------------------------------------------------- |
| P2B-0001 | dashboard-shell-and-auth-flow        | Shell + GitHub OAuth + ⌘K Forge palette.                       |
| P2B-0002 | dashboard-onboarding-and-credentials | Org-setup full track + minimal existing-project track.         |
| P2B-0003 | dashboard-project-and-spec           | Chat-primary project view + spec form + routing settings UI.   |
| P2B-0004 | dashboard-run-detail-view            | Cost bar + trajectory spine + writer reasoning.                |
| P2B-0005 | dashboard-history-and-costs          | Stacked spend, breakdown table, projections (no heatmap/DORA). |
| P2B-0006 | operator-triggered-live-workflow     | End-to-end live wiring incl. forced-halt recovery exercise.    |
| P2B-0007 | phase2-end-to-end-demo               | Recorded Phase 2 closeout evidence.                            |
| P2B-0008 | dashboard-failure-recovery           | Revise / replan / rollback / inspect recovery cards.           |
| P2B-0009 | dashboard-greenfield-new-project     | Thin greenfield form. **STRETCH** — Phase 3 if not done.       |

### Phase 2 Exit Criteria

Phase 2 is complete when, on merged `main`:

- The orchestrator and dashboard require operator auth; GitHub OAuth sign-in is the first identity provider; organizations are first-class tenants; an OIDC provider interface is in place.
- Dev and prod compose profiles are split; the prod profile starts only with operator-provided secrets.
- Workflow state, project config (with 6-role fallback-chain routing), event payloads (with semantic-rich writer/planner fields), all five Answerer schemas, and the product-entity model (orgs/personas/behaviors/milestones/spec-dependencies) are Zod-sourced with no `unknown`/`Record<string, unknown>`/raw-cast paths remaining in workflow code.
- The redaction layer applies on read against actor access scope; raw access is audited.
- The allocator sidecar owns the Docker socket; runners are per-run ephemeral; workspaces and `CODEX_HOME` are wiped on release.
- Cost records exist for every real Codex call; no unknown-source rows; all three PROJECT_BRIEF §4 cost models render in the dashboard.
- The Planner emits typed subtasks; checker and auditor rejection loops execute with a configurable retry budget.
- The Forge data substrate (threads + turns + tool surface + read-only stubs + operator-button write actions) supports the dashboard's narration and palette features.
- The workflow-insights contract emits at least the three v0 insights (retry_hotspot, model_mismatch, pace_anomaly) where the data supports them.
- The notifications matrix schema admits all hi-fi channels; the ntfy channel is implemented and wired.
- The dashboard runs end-to-end for an operator: sign in, org onboarding, credential import, repo link (minimal existing), spec creation against a milestone + behavior, run trigger, run detail inspection, cost review, AND **failure recovery on a forced-halt run**.
- `just acceptance-easy` and `just acceptance-medium` pass end-to-end against live fixture repos.
- The Phase 2 demo evidence (run IDs, PR URL, recovery-action lineage) is committed under this section.

> **Note (updated):** the two criteria above that require a run to _complete through the dashboard_ depended on the run executor (deferred, built in Phase 3 as **P3-0001**, landed; the `acceptance-easy`/`-medium` direct-execution harnesses were removed for the real `TANREN_RUN_WORKER=1` dequeue→execute path). Their final validation — the **P3-0009 live demo** — is now **DONE**: the full real loop was live-validated to a merged PR across three tiers (easy/medium/hard, the hard one a private repo) with real Codex and real credentials. See [`docs/operator-guide/live-validation-findings.md`](docs/operator-guide/live-validation-findings.md) and the live tracker [`docs/roadmap/tempering.md`](docs/roadmap/tempering.md).

### Phase 2A live proof

**Easy tier (`just acceptance-easy`)** — live-proven on `main`: run `run_cd09b273-b0e9-4c5f-90ca-c632977b7643`, `outcome=phase2_easy_complete`, status `done`, draft PR `https://github.com/cat-cave/tanren-fixture-easy/pull/7`, CI passed, tasks `plan/write/check/audit/ci`, 3 cost rows (write/check/audit, `subscription`/`unknown` — the easy tier runs the Phase 1 linear flow, so no ccusage/credits reconcile; that's the medium tier), 98s. **Medium tier (`just acceptance-medium`)** — the planner loop (`runPlannerLoopWorkflow` + live driver) is live-proven against `cat-cave/tanren-fixture-medium`: ≥ 2 subtasks, a genuine checker rejection → `planner.rerequested` re-plan, and credit-drawdown cost accounting. The checker judges intent against explicit criteria; the deterministic test gate is post-PR CI. (The checker-rejection loop is opportunistic, not a per-run assertion. The in-loop two-tier gate-check is the Phase 3 opener.)

## Phase 3: v0 Completion

Status: **essentially complete and merged.** The Tier 1 foundational vertical slice (P3-0001…0009) and the bulk of the Tier 2 expansion (P3-0010…0030) are merged on `main`. Scope buckets in [`docs/roadmap/phase-3.md`](docs/roadmap/phase-3.md); the **spec-by-spec plan (P3-0001…0030)** is in [`docs/roadmap/phase-3-specs.md`](docs/roadmap/phase-3-specs.md), split into a **Tier 1 foundational vertical slice** (the loop machinery that makes one real operator-driven run execute→green→merge) and **Tier 2 expansion**.

**Reconciliation with Phase 2B (resolved):** Phase 2B shipped the operator dashboard _surfaces_, but the orchestrator had **no run executor** (the implicit Tier 1 prerequisite named P3-0001). **P3-0001 landed** — a background run worker (`TANREN_RUN_WORKER=1`, `services/orchestrator/src/engine/worker/`) claims + executes `plan` jobs, so a dashboard-triggered run runs end-to-end; the direct-execution acceptance scripts were removed in favor of the real dequeue+execute path. The P2B-0006/P2B-0008 + Phase 2 Exit Criteria "runs end-to-end" claims are met. Full reconciliation: [`docs/roadmap/phase-3-specs.md`](docs/roadmap/phase-3-specs.md). Phase 3 closed the v0 workflow above the Phase 2 operator-control baseline, added the remaining providers, brought the hi-fi's deferred surfaces online, hardened deployment, and cleared the audit's remaining medium-priority items. Delivered buckets (merged): workflow completion (review/merge with per-repo configurable integrations · two-tier in-loop gate-checks from a repo-sourced `tanren-ci.yml`, with the checker Answerer reframed to intent/review-only) · thick Forge LLM backend · spec DAG canvas · spec discovery flow · full greenfield + brownfield onboarding · `tanren-config` audit-gate · subscription-window heatmap + DORA · live preview deploys · demo-role LLM wiring · additional workflow insights (stuck, review_stall) · scheduled audits library · issue source ingestion (GitHub/Sentry/Linear/Jira connectors) · external-push governance posture · provider expansion (Claude, opencode-Zai, aider) · notification channel rollout (all 9 channels: ntfy/slack/github-checks/teams/discord/email/twilio/pagerduty/webhook) · acceptance hard tier · allocator expansion (static/sidecar/manual-ssh/Hetzner/DigitalOcean/GCP/AWS-EC2/Kubernetes) · CI/queue hardening · observability · deployment hardening including Authentik OIDC.

**Live to-do (authoritative, across four dimensions)** — the live forward tracker is now [`docs/roadmap/tempering.md`](docs/roadmap/tempering.md) (what's done, what's next); the detailed four-dimension plan with status + sequencing is [`docs/roadmap/forward-roadmap.md`](docs/roadmap/forward-roadmap.md). The critical-path "gate" (A) is **DONE** — the run loop is live-validated to merged PRs across three tiers. The top remaining structural items are **Vault per-run scoped creds** + the remaining **data-access-layer** clusters. Status markers: done / in-progress / remaining / held.

- **A — the real run is DONE.** The harness-integration frontier that paused the project (`All configured authentication methods failed`) is **resolved** (durable Vault-backed credential registry restored runner-identity resolution). The full loop `plan → real-agent write → check → audit → in-loop gate → draft PR → CI → review → merge` is live-validated to a **merged PR across three tiers**: easy (`open`/`direct_merge`/`auto`), medium (same + a two-tier `tanren-ci.yml`), and hard (same + `reviewPolicy: simulated`, an orchestrator-managed reviewer that posts a real GitHub `COMMENT` review and drives the verdict internally; the hard tier is a **private** repo). The earlier live run also caught+fixed a class of RLS-completeness bugs (now regression-tested). See [`docs/operator-guide/live-validation-findings.md`](docs/operator-guide/live-validation-findings.md). A live run still needs a **fresh/reset dev DB** (`0026` makes `org_id` NOT NULL). Remaining near-term: post-merge auto-issue on a post-merge check failure.
- **B — pipeline experimentation.** The tanren-method benchmark toolkit ([`docs/roadmap/tanren-method-benchmark.md`](docs/roadmap/tanren-method-benchmark.md)) is **code-complete**: `experiments`/`experiment_cells`/`experiment_trials` entities (migration `0033`), the `TrialScorecard` projection, `deriveCellScorecard`/`compareCells` reducers (bootstrap-CI + Mann–Whitney), a `BenchmarkRunner` scheduling trials through the real worker, a post-merge hidden-`accept` step (`benchmark.accept.*`, migration `0034`), and a `tanren experiments`/`tanren cells` CRUD + `report`/`compare` CLI + `/orgs/:orgId/experiments` routes. The remaining piece is the **seed corpus** (content). Real-cost-gated. **C — refactor/scale prepwork** ([`docs/architecture/future-refactor-and-scale.md`](docs/architecture/future-refactor-and-scale.md)): a conformance-covered `Repositories` DAL seam exists (routes + run-lifecycle writes migrated off raw SQL); `LISTEN/NOTIFY` replaced the 1s polling; conformance suites exist for Allocator/JobQueue/EventStore/SecretStore/CostResolver/Repositories. Remaining: the forge DAL cluster (recovery has no raw SQL; quota is deleted with `QuotaPolicy`), the first whole-repo `mutation-full` baseline, `typify→serde` codegen. Rust rewrite is long-horizon.
- **D — managed-hosting.** RLS + plane-split P1→**P3c** **done + live-validated**: events/cost (P3b, migration `0031`) **and** run/spec/task lifecycle writes (P3c, migration `0035`) route through the control-plane `/internal/*` endpoints; the `tanren_dataplane` role's write grants on all of those are dropped (`42501` proofs `smoke-plane-split-p3b`/`-p3c`). The standalone **allocator** service is **org-threaded** (`smoke-rls-allocator`). The credential registry is **durable** (Vault-backed, survives restart); legacy top-level import routes are deleted. **Vault per-run scoped creds** are **done** — a per-run orphan child token scoped to exactly that run's cred paths backs the run's `SecretStore`; the `dev-root-token` fallbacks are removed (broad token REQUIRED, fail-hard). Remaining: prod hardening. New tenant work runs org-scoped or RLS returns zero rows.
- **Held:** the **agy** harness (broken headless; pi/reasonix writer-only adapters built, #145) and agy/pi/reasonix **live** validation (await credentials); the **GitLab / VCS-provider** abstraction ([`docs/roadmap/vcs-adapterization-plan.md`](docs/roadmap/vcs-adapterization-plan.md), deferred until a real 2nd backend; delivery is already native — Tanren's own merge queue + SSH gate, no Mergify, no Actions — so the residual coupling is just the thin `VcsProvider` surface: PR/review/check-publication/merge-accept); the Rust rewrite / native harness. (Resolved loose-ends: workspace-bootstrap wiring #137; Forge write-action approval #139; the eight thick-product hi-fi surfaces are built.)

PROJECT_BRIEF §3.1 (opencode provider list) was amended at Phase 3 entry to remove the Wafer reference; PROJECT_BRIEF was otherwise fixed during Phase 2 planning. <br/> **Multi-tenancy / plane-split / strictness / longevity expansion (merged on `main`)** — tracked in [`docs/roadmap/expansion-and-strictness-plan.md`](docs/roadmap/expansion-and-strictness-plan.md), [`docs/roadmap/saas-rls-and-plane-split-plan.md`](docs/roadmap/saas-rls-and-plane-split-plan.md), and [`docs/roadmap/R-WAVES.md`](docs/roadmap/R-WAVES.md). Beyond the Phase 3 buckets: **RLS fully DB-enforced + live-validated** — restricted `tanren_app` role (NOBYPASSRLS), narrow `tanren_system` BYPASSRLS pool, deny-by-default `USING`+`WITH CHECK` policies on every tenant table (migrations `0029`/`0030`; `db/src/orgScope.ts`); **plane-split P1→P3c** — standalone `worker` deployable, mTLS claim endpoint, control-plane write endpoints + `RunStateWriter` seam, and the de-privileged `tanren_dataplane` role whose `events`/`cost_records` (migration `0031`) **and** run/spec/task lifecycle (migration `0035`) write grants are dropped (`42501` negative tests); the standalone **allocator** service org-threaded under RLS; the **strictness gate** hardened to a 15-step `just fast-check` with coverage floors + structural ratchets; **~13 Stryker mutation clusters (71–98%)** + a weekly full-repo mutation job (`mutation-weekly.yml`); **oxlint warnings ~3052 → ~5** (~25 rules warn→error); tenant-namespaced Vault refs (`credential/<slug>/<scope>/<ownerId>/<name>`), a **quota/admission-gate + metering-export seam**, a **BYOK-vs-managed provider toggle**, pluggable **secret-store backends** (Vault/GCP-SM/AWS-SM/1Password), and identity (`github_oauth` / generic OIDC / **Authentik** / `local_dev`).
