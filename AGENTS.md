# Agent Operating Rules

Tanren follows `PROJECT_BRIEF.md` as the source of truth. When this file and the brief conflict, stop and reconcile the brief first.

## Required Local Checks

Run the narrowest useful check while editing, then run the full gate before handing off:

```sh
corepack pnpm run format:check
corepack pnpm run lint
corepack pnpm run check:architecture
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run compose:config
corepack pnpm run check
```

The compose smoke for infrastructure changes is:

```sh
docker compose build orchestrator dashboard runner
TANREN_RUNNER_AUTHORIZED_KEY="$(cat /tmp/tanren_runner_key.pub)" docker compose up -d postgres vault orchestrator dashboard runner ntfy
```

Then verify CLI `doctor`, `hello`, and `status`, plus runner SSH.

## Worktree Isolation

Roadmap specs must declare owned paths before work starts. Parallel agents should avoid touching files outside the spec's ownership unless they first update the spec dependency graph or coordinate a shared contract file.

Do not revert user changes. If a file has unrelated edits, preserve them and scope your patch to the task.

## Version Verification

Before changing any version pin, verify the current version against the upstream project source. This applies to GitHub Actions, Docker images, Node, pnpm, Postgres, Vault, oxlint, TypeScript, and any new runtime dependency. Record the upstream source in the PR or roadmap spec.

## Brief Invariants

- Agent workloads run in containers and are reached through SSH.
- Writers and Answerers are distinct roles.
- Events are appended only through `services/orchestrator/src/engine/eventStore.ts`.
- Cost records use only `provider_direct`, `ccusage`, `codexbar`, or `opportunity_computed`.
- No placeholder cost source is allowed.
- Source, config, and docs files stay under 500 lines unless an exception is documented in `docs/contracts/architecture-checks.md`.
