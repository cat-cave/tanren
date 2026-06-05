# Agent Operating Rules

Tanren follows `PROJECT_BRIEF.md` as the source of truth. When this file and the brief conflict, stop and reconcile the brief first.

## Required Local Checks

Run the narrowest useful check while editing (e.g. **`just affected-typecheck`** /
**`affected-test`** — only what changed vs `origin/main`), then run the full gate
before handing off. The canonical gate is the justfile — **`just fast-check`** (the
non-build gate) and **`just ci`** (adds the build), then **`just smoke`**. The
toolchain is oxc/native — **tsgo** (typecheck+build), **oxlint** +
**`oxlint --type-aware`** (lint), **oxfmt** (format), **vitest 4** (test),
**Turborepo** (build/typecheck cache); no `tsc`. The per-step pnpm scripts below
are the same checks, lower-fidelity than the recipes:

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

## Parallel Work — Worktrees

Parallel work runs in isolated git worktrees, one unit of work per PR. Keep independent specs in separate worktrees. Serialize any PR that edits a DB migration or a shared file (nav, `screens.ts`, `main.ts`). Put the PR context and validation in the commit message.

## Version Verification

Before changing any version pin, verify the current version against the upstream project source. This applies to GitHub Actions (Tanren's own monorepo CI), Docker images, Node, pnpm, Postgres, Vault, oxlint, TypeScript, and any new runtime dependency. Record the upstream source in the PR or roadmap spec.

## Brief Invariants

- Agent workloads run in containers and are reached through SSH.
- Writers and Answerers are distinct roles.
- Events are appended only through `services/orchestrator/src/engine/eventStore.ts`.
- Token accounting is mandatory and recorded as disjoint typed buckets; cost is best-effort.
- Cost records use `billing_mode` in `per_token`/`subscription`/`self_hosted`/`unattributed` and `cost_basis` in `ccusage`/`provider_response`/`credits`/`unknown`/`unattributed`. `cost_usd` may be NULL when `cost_basis = 'unknown'`.
- No placeholder cost source is allowed.
- Source, config, and docs files stay under 500 lines unless an exception is documented in `docs/contracts/architecture-checks.md`.
