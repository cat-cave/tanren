# Phase 2A Acceptance Gate

`just acceptance` is the **executable Phase 2A release gate** owned by
P2A-0015. It runs the easy and medium fixture repos through the real
Tanren workflow end-to-end and asserts persisted outcome, PR URL, CI
status, and cost attribution. The gate is **local-only** — it never runs
in GitHub Actions because it calls real Codex CLIs and creates real draft
PRs against the fixture repos.

## Recipes

```sh
just acceptance-easy     # easy tier (Phase 1 fixture-easy repo)
just acceptance-medium   # medium tier (Phase 2 fixture-medium repo, pending operator setup)
just acceptance          # both
```

Each recipe calls `scripts/acceptance/check-env.sh` first, which
fails fast if any required environment variable is missing.

## Required environment

The acceptance gate reuses the Phase 1 live-proof env-var contract:

| Variable                       | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `TANREN_CODEX_AUTH_JSON_FILE`  | Path to the Codex auth bundle (ChatGPT subscription JSON). |
| `TANREN_GITHUB_TOKEN_FILE`     | Path to a GitHub PAT file with `repo` scope on the fixture repo. |
| `TANREN_GITHUB_REPO_URL`       | HTTPS URL of the fixture repo (`https://github.com/cat-cave/tanren-fixture-easy` for easy). |
| `TANREN_DATABASE_URL`          | Postgres URL pointing at the local compose stack. |
| `TANREN_VAULT_TOKEN`           | Vault root token (dev token in the dev profile). |
| `TANREN_SSH_HOST_FINGERPRINT`  | SHA256 fingerprint of the runner SSH host key. |

Optional overrides:

| Variable                             | Default                                       |
| ------------------------------------ | --------------------------------------------- |
| `TANREN_SSH_KEY_PATH`                | `/tmp/tanren_runner_key`                      |
| `TANREN_SSH_HOST`                    | `127.0.0.1`                                   |
| `TANREN_SSH_PORT`                    | `2222`                                        |
| `TANREN_SSH_USER`                    | `tanren`                                      |
| `TANREN_VAULT_ADDR`                  | `http://127.0.0.1:18200`                      |
| `TANREN_GITHUB_BASE_BRANCH`          | `main`                                        |
| `TANREN_ACCEPTANCE_TIMEOUT_MS`       | `300000` (5 min per Codex call)               |
| `TANREN_ACCEPTANCE_MAX_CI_POLLS`     | `18`                                          |
| `TANREN_ACCEPTANCE_CI_POLL_DELAY_MS` | `10000`                                       |

The runner SSH fingerprint matches what `just live-phase1-fixture` already
uses; the same `ssh-keyscan` snippet from `justfile` populates it.

## What the gate asserts (persisted-state criteria)

After the workflow completes, the acceptance script reads back from the
database and asserts:

- `run.outcome = 'phase2_easy_complete'` (or `phase2_medium_complete`).
- `run.pr_url` matches `https://github.com/.+/pull/\d+`.
- A `ci.passed` event is present in the event timeline.
- `cost_records` exist for every required role:
  - Easy: `write`, `check`, `audit`.
  - Medium: `plan`, `write`, `check`, `audit`.
- No `cost_records` row has an unknown source (P2A-0011 invariant).
- Medium only: ≥ 2 `write` tasks (planner emitted ≥ 2 subtasks).
- Medium only: ≥ 1 `planner.rerequested` event (checker rejection loop fired).

If any assertion fails the script exits non-zero with a clear error and
the persisted `runId` for the operator to investigate.

On success the script prints a structured proof block that the operator
pastes into `ROADMAP.md` under the Phase 2A live-proof section.

## Easy tier (live today)

```sh
TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json \
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token \
TANREN_GITHUB_REPO_URL=https://github.com/cat-cave/tanren-fixture-easy \
TANREN_DATABASE_URL=postgres://tanren:tanren@localhost:5432/tanren \
TANREN_VAULT_TOKEN=dev-root-token \
TANREN_SSH_HOST_FINGERPRINT="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')" \
just acceptance-easy
```

The easy tier reuses the Phase 1 fixture flow (single-file change, single
subtask, no rejection loop) and tags the resulting run with the
`phase2_easy_complete` outcome value after every Phase 2 criterion has
been verified.

## Medium tier (pending operator setup)

`just acceptance-medium` currently validates the env and prints a pending
notice. To unblock the live runner, the operator pre-creates a fresh
GitHub repo `cat-cave/tanren-fixture-medium`, pushes the initial content
from `fixtures/acceptance-medium/` to it, and the live runner code is
landed in a follow-up commit.

### Initial fixture-medium content

```
fixtures/acceptance-medium/
├── README.md
├── package.json          # vitest setup
├── src/
│   └── status.ts         # placeholder getStatus()
└── tests/
    └── status.test.ts    # placeholder vitest case
```

### Medium acceptance spec text

The acceptance script asks Tanren to:

> Implement `getStatus()` in `src/status.ts` that returns a JSON shape
> `{ ok: boolean, version: string }`. Add a vitest case in
> `tests/status.test.ts` that verifies both fields. Mention the function
> in the README.

This is crafted to force:

- The planner to emit ≥ 2 subtasks (status function + test extension,
  plus the README mention).
- The checker to reject the first attempt at least once (e.g. if the
  writer skips the README mention the audit-level behavior verification
  picks it up and the planner is re-invoked).

The dry-run smoke test in
`services/orchestrator/tests/phase2AcceptanceMedium.test.ts` gates the
medium criteria against synthetic completed-run snapshots so CI catches
regressions in `scripts/acceptance/common.ts` even while the live
runner is pending.

## Reading the proof block

On success the script emits a block like:

```
==========================================
  Tanren Phase 2A — acceptance-easy proof
==========================================
runId           : run_xxxxxxxx-...
outcome         : phase2_easy_complete
status          : done
prUrl           : https://github.com/cat-cave/tanren-fixture-easy/pull/N
ciStatus        : passed
tasks           : plan, write, check, audit, ci
costRecords     : 3 (write:codexbar, check:codexbar, audit:codexbar)
plannerReruns   : 0
repo            : https://github.com/cat-cave/tanren-fixture-easy
duration_s      : XX
events_total    : NN
==========================================
```

Paste the block into `ROADMAP.md` under the Phase 2A live-proof section
as the completion evidence Phase 1 documented with its
`run_a347d451-...` proof.

## Failure modes

| Symptom                                              | Likely cause                                        |
| ---------------------------------------------------- | --------------------------------------------------- |
| `required env vars missing` and exit 2               | One of the variables above is unset.                |
| `pr_url is null` and exit 1                          | The Codex writer failed to commit; check task rows. |
| `ci.passed event not present` and exit 1             | The fixture repo's CI failed; inspect the draft PR. |
| `cost_records have unknown source rows`              | A new adapter bypassed `CostRecorder`; this is a release block (P2A-0011 invariant). |
| `expected ≥ 1 planner.rerequested event`             | Medium spec was too easy; revise the spec text so the checker rejects the first attempt. |
