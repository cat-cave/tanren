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
docker compose -f compose.dev.yml build orchestrator dashboard runner
TANREN_RUNNER_AUTHORIZED_KEY="$(cat /tmp/tanren_runner_key.pub)" TANREN_RUNNER_IDENTITY_PRIVATE_KEY="$(cat /tmp/tanren_runner_key)" docker compose -f compose.dev.yml up -d postgres vault orchestrator dashboard runner ntfy
```

Then verify CLI `doctor` and `status`, plus runner SSH (the synthetic `hello` workflow was purged from the runtime; `just smoke-connectivity` is the fake-free connectivity check). The dev and prod profiles split is described in `docs/operator-guide/deploy.md` (P2A-0004).

## Worktree Isolation

Roadmap specs must declare owned paths before work starts. Parallel agents should avoid touching files outside the spec's ownership unless they first update the spec dependency graph or coordinate a shared contract file.

Do not revert user changes. If a file has unrelated edits, preserve them and scope your patch to the task.

## Mergify Stacks

Use Mergify stacks for dependent Phase 1+ PRs. Each commit in a stack becomes its own PR and must be independently green. Keep independent specs in separate stacks; use one stack only when later commits genuinely depend on earlier commits.

Do not manually edit stack-managed PR titles or bodies. Put the PR context and validation in the commit message, use `mergify stack push`, and add a `mergify stack note` before pushing any amendment to an already-pushed commit.

## Version Verification

Before changing any version pin, verify the current version against the upstream project source. This applies to GitHub Actions, Docker images, Node, pnpm, Postgres, Vault, oxlint, TypeScript, and any new runtime dependency. Record the upstream source in the PR or roadmap spec.

## Brief Invariants

- Agent workloads run in containers and are reached through SSH.
- Writers and Answerers are distinct roles.
- Events are appended only through `services/orchestrator/src/engine/eventStore.ts`.
- Token accounting is mandatory and recorded as disjoint typed buckets; cost is best-effort.
- Cost records use `billing_mode` in `per_token`/`subscription`/`self_hosted` and `cost_basis` in `ccusage`/`provider_response`/`credits`/`unknown`/`unattributed`. `cost_usd` may be NULL when `cost_basis = 'unknown'`.
- No placeholder cost source is allowed.
- Source, config, and docs files stay under 500 lines unless an exception is documented in `docs/contracts/architecture-checks.md`.
