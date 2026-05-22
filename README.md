# Tanren

Tanren is the platform for end-to-end agentic code development.

This repository contains the Phase 0 kernel for Tanren v3: a Docker Compose stack, typed Postgres schema, orchestrator, dashboard, runner image, thin CLI, SSH runner substrate, local Docker allocator, git workspace capture, and a durable fake planner/writer/checker/auditor hello workflow.

The current hello workflow is still synthetic, but it now crosses the same execution boundary real agents will use: the orchestrator allocates a runner, executes through SSH, mutates a git workspace in the runner, captures real diff/commit metadata, persists task/job/run state, and exposes the result through the CLI.

## Local Smoke

```sh
corepack enable
pnpm install
corepack pnpm run check
just smoke
```

`just smoke` builds the orchestrator, dashboard, and runner images, starts Postgres, Vault, orchestrator, dashboard, runner, and ntfy, then verifies:

- `tanren doctor`
- `tanren hello`
- `tanren status <run_id>`
- direct runner SSH
- the live SSH integration test

To clean up the smoke stack:

```sh
just compose-down
```

If you are moving from an older local baseline, reset the local Postgres volume before the smoke:

```sh
docker compose down -v
```

## Roadmap

`PROJECT_BRIEF.md` is the source of truth. `ROADMAP.md` records the incremental implementation plan and now marks Phase 0 complete. Phase 1 begins the move from the durable fake workflow to the first real-agent PR loop.
