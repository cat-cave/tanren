# Operator Guide

## Current state (post-Phase 1)

Phase 1 (real-agent PR loop) is complete and live-proven on `main`. The Phase 1 baseline that Phase 2 specs extend:

- The orchestrator and dashboard run from `docker compose up`; the orchestrator drives a runner container over a real SSH boundary; the local Docker allocator records and releases runner allocations.
- A persisted spec for an owned fixture repository can be planned, written by a real Codex CLI writer in a runner workspace, judged by Codex `--output-schema` Answerers on checker and auditor verdicts, and shipped as a draft PR. CI status against the PR is polled and persisted.
- The thin CLI (`tanren doctor`, `tanren status`) exists. Live Phase 1 proof: run `run_a347d451-3911-470d-b506-280b602343a9`, draft PR `https://github.com/cat-cave/tanren-fixture-easy/pull/6`.

Phase 2 turns this baseline into an operator-controlled product surface. The end state is that an operator can register a GitHub org as a Tanren tenant, link a repo, configure credentials and routing, submit a spec, run the real workflow, recover from failure, and view the resulting PR — all through the dashboard with no CLI or DB access. Phase 2 spec entries are tracked in `ROADMAP.md` and `docs/roadmap/phase-2a-specs.md` / `docs/roadmap/phase-2b-specs.md`. The Phase 2 readiness audit (`docs/audits/phase2-readiness.md`) is the backlog input.

## Phase 2 backlog at a glance

- **Phase 2A (operator backend + contracts, 20 specs)**: organizations as tenants; multi-user GitHub OAuth; typed workflow state; 6-role fallback-chain routing; semantic-rich events; Answerer schemas for plan/check/audit/demo/forge; redaction by access scope; allocator sidecar isolation; mandatory cost attribution; planner feedback loops; Forge narration substrate; workflow insights; product entities (personas/behaviors/milestones/spec-deps); typed CLI/API + `/doctor`; run-detail read API; acceptance gate (easy + medium); design tokens import; notifications matrix; dev/prod compose split.
- **Phase 2B (operator dashboard, 9 specs incl. one stretch)**: dashboard shell with ⌘K palette; org-full + minimal-existing onboarding; chat-primary project view; spec creation; run detail; history and costs; failure recovery; operator-triggered live workflow; demo recording. Optional: thin greenfield project create.

Open the per-spec detail files for the implementation contracts (Owns / Consumes / Produces / What / Why / How / Test plan / Quality bar / Real-functionality validation / Worktree-isolation safety) of every Phase 2 entry.

## Running the stack

Start with the local smoke:

```sh
corepack enable
corepack pnpm install
just smoke
```

`just smoke` builds the images, starts the compose stack, runs `tanren doctor` (orchestrator / Postgres / Vault connectivity), verifies direct runner SSH, runs the live SSH integration test, then drives the real run path across the API↔worker process boundary (`smoke-plane-split-*`) and the RLS isolation proofs.

To inspect manually while the stack is up:

```sh
corepack pnpm --filter @tanren/cli tanren doctor
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
docker compose -f compose.dev.yml down -v
```

For prod deployment and the Vault init flow, see `deploy.md` (P2A-0004).
