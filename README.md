# Tanren

Tanren is the platform for end-to-end agentic code development.

This repository currently contains the hello-world scaffold: the compose stack, database schema, orchestrator, dashboard, runner image, thin CLI, and fake provider adapters needed to prove connectivity before real agent workflows are implemented.

## Local Smoke

```sh
corepack enable
pnpm install
pnpm run check
docker compose up --build
```

If you are moving from the pre-Drizzle hello-world baseline, reset the local Postgres volume before this smoke:

```sh
docker compose down -v
```

In another shell:

```sh
pnpm --filter @tanren/cli tanren doctor
pnpm --filter @tanren/cli tanren hello
```
