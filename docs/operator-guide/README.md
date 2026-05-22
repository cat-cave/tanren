# Operator Guide

Start with the local smoke:

```sh
corepack enable
corepack pnpm install
just smoke
```

`just smoke` builds the images, starts the compose stack, runs `tanren doctor`, triggers `tanren hello`, prints `tanren status <run_id>`, verifies direct runner SSH, and runs the live SSH integration test.

To inspect manually while the stack is up:

```sh
corepack pnpm --filter @tanren/cli tanren doctor
corepack pnpm --filter @tanren/cli tanren hello
corepack pnpm --filter @tanren/cli tanren status <run_id>
```

`tanren status <run_id>` returns the run row, ordered planner/writer/checker/auditor tasks, events, and cost records.

To clean up:

```sh
just compose-down
```

If you are moving from an older local database shape, reset the volume before running the smoke:

```sh
docker compose down -v
```
