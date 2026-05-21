# ROADMAP.md

Tanren v0 is built by progressively making the hello-world workflow more real until a persisted spec is planned, implemented, reviewed, PR'd, CI-validated, and merged by the platform.

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

**Owns**: `services/orchestrator/src/engine/helloWorkflow.ts`, `services/orchestrator/src/main.ts`, `services/orchestrator/src/engine/events.ts`, `services/orchestrator/tests/**hello**`, `.github/workflows/ci.yml` and `compose.yml` only for hello SSH smoke wiring, `cli/src/main.ts` only for output shape, `services/dashboard/src/main.tsx` only for displaying new hello events.
**Consumes**: SPEC-0003.
**Produces**: the current hello workflow executed across the real runner boundary.

**What**: Extend hello-world so at least one workflow step executes over SSH in the allocated runner.
**Why**: This is the smallest meaningful proof that Tanren's persisted workflow uses the same execution boundary real agents will use.
**How**: Allocate a runner, execute a deterministic command over SSH, append declared events for allocation/execution/release, and expose the result through CLI status and dashboard run views.

**Test plan**: hello workflow tests, CLI smoke for `doctor`, `hello`, and `status`, compose smoke with runner SSH, `corepack pnpm run check`.
**Quality bar**: The old in-process fake workflow remains understandable, but execution proof now crosses the real runner boundary.
**Real-functionality validation**: `tanren hello` persists SSH output from the runner and `tanren status <run_id>` shows the runner events.
**Worktree-isolation safety**: This spec owns hello workflow surfaces and minimal CLI/dashboard display changes.

### SPEC-0005 - workspace-git-contract

**Owns**: `services/orchestrator/src/engine/workspace/**`, `services/orchestrator/src/engine/providers/fake.ts`, `services/orchestrator/src/engine/providers/types.ts`, `fixtures/**`, `runner/**` only for workspace prerequisites.
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

Phase 0 is complete when all of the following are true:

- `db/src/schema.ts` is the single source of truth and generated migrations are drift-checked.
- The orchestrator executes workflow commands over SSH in a runner.
- The local allocator records and releases runner allocations.
- `tanren hello` crosses the runner SSH boundary.
- The fake writer mutates a real git workspace in the runner.
- The orchestrator captures real diff/commit metadata for checker/auditor use.
- Spec, run, and task state transitions are durable enough for later async real-agent work.
- `corepack pnpm run check` passes.
- Compose smoke proves CLI `doctor`, `hello`, `status`, and runner SSH.

Phase 1 can begin after these contracts are stable enough for parallel subagents to consume them.
