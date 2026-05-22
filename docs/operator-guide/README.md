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

## Live Phase 1 Proof

With compose Postgres, Vault, orchestrator, and runner running, the opt-in live proof exercises the real-agent workflow:

```sh
TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json \
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token \
TANREN_GITHUB_REPO_URL=https://github.com/cat-cave/tanren-fixture-easy \
just live-phase1-fixture
```

Expected proof:

- Vitest reports `services/orchestrator/tests/phase1Fixture.live.test.ts` passing.
- The persisted run has `outcome = 'phase1_fixture_complete'`.
- `plan`, `write`, `check`, `audit`, and `ci` tasks are all `done`.
- Events include `github.pr.created`, `ci.passed`, and `phase1.fixture.completed`.
- The fixture repository receives a draft PR from the runner-produced branch.

To clean up:

```sh
just compose-down
```

If you are moving from an older local database shape, reset the volume before running the smoke:

```sh
docker compose down -v
```
