# Tanren

Tanren is the platform for end-to-end agentic code development.

This repository contains the Phase 1 kernel for Tanren v3: a Docker Compose stack, typed Postgres schema, orchestrator, dashboard, runner image, thin CLI, SSH runner substrate, local Docker allocator, git workspace capture, Vault-backed credentials, Codex writer/check/audit adapters, GitHub draft PR creation, CI polling, and a durable workflow event log.

The baseline `hello` workflow remains a synthetic smoke path, but Phase 1 has live-proven the real-agent loop: the orchestrator can load managed credentials, allocate a runner, prepare a fixture repository workspace over SSH, run Codex as Writer and structured Answerer, open a draft GitHub PR, poll CI, and persist the result as inspectable run/task/event state.

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

The opt-in Phase 1 live proof requires a managed Codex auth bundle, a GitHub token file, and an owned fixture repository:

```sh
TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json \
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token \
TANREN_GITHUB_REPO_URL=https://github.com/cat-cave/tanren-fixture-easy \
just live-phase1-fixture
```

That command should leave a persisted run with `outcome = 'phase1_fixture_complete'`, `plan`, `write`, `check`, `audit`, and `ci` tasks all `done`, a draft fixture PR URL, and a `ci.passed` event.

To clean up the smoke stack:

```sh
just compose-down
```

If you are moving from an older local baseline, reset the local Postgres volume before the smoke:

```sh
docker compose -f compose.dev.yml down -v
```

The single `compose.yml` was split into `compose.dev.yml` (the current local baseline) and `compose.prod.yml` in P2A-0004. See `docs/operator-guide/deploy.md` for the prod profile and Vault init flow.

## Roadmap

`PROJECT_BRIEF.md` is the source of truth. `ROADMAP.md` records completed Phase 0 and Phase 1 proof, plus the Phase 2 plan for turning the live workflow into an operator-controlled product surface.
