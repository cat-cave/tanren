# Tanren Acceptance Gates

> **Removed in P3-0001 (2026-05-28).** The direct-execution acceptance
> drivers (`just acceptance`, `acceptance-easy`, `acceptance-medium`,
> `scripts/acceptance/easy.ts`, `scripts/acceptance/medium.ts`) have been
> **deleted**. The system is now only ever exercised through the real
> dequeue→execute path: a dashboard/API-triggered run enqueues a `plan`
> job and the **background run worker** (`TANREN_RUN_WORKER=1`, see
> `services/orchestrator/src/engine/worker/`) claims and executes it. To
> exercise a full run live, trigger it through the dashboard/API with the
> worker enabled. The per-tier persisted-state **assertions** survive as
> CI dry-run smokes (`services/orchestrator/tests/phase2Acceptance{Easy,Medium}.test.ts`,
> backed by `scripts/acceptance/common.ts`). Component-level live smokes
> (`just live-codex-*`, `live-github-*`, `live-ci-poll`, `live-phase1-fixture`)
> remain. The rest of this document is retained for historical context.

---

# Phase 3 Acceptance — Hard Tier (final v0 gate)

> **P3-0026.** The final v0 acceptance gate. Where the easy/medium tiers
> proved a _clean_ run end-to-end, the **hard tier** proves the system
> survives its three hardest paths in a single run:
>
> 1. a **planner re-plan** driven by the in-loop deterministic gate
>    (P3-0005) failing a writer iteration,
> 2. an **auditor rejection loop** (`recommendedAction: loop_to_planner`)
>    routed back through the planner as rework, and
> 3. a **merge conflict** resolved through the P3-0008 conflict-resolver
>    hook so the run still lands a coherent terminal state.
>
> Like everything since P3-0001, the hard tier is exercised **only through
> the real dequeue→execute path** — a triggered run enqueues a `plan` job
> and the background worker (`TANREN_RUN_WORKER=1`) claims and executes it.
> There is **no** direct-execution script (the deleted `scripts/acceptance/*`
> are not reintroduced).

## Deterministic hard-tier gate (CI / local, no live credentials)

The deterministic proof is a real-system test that runs the **actual**
`runPlannerLoopWorkflow` through the worker's claim→execute seam
(`executeNextPlanJob`), with the adapters / gate / review / merge probes
scripted through the workflow's existing injection seams to force all
three hard paths. No real Codex, SSH, or GitHub is touched.

```sh
just acceptance-hard      # runs the deterministic hard-tier test
# or directly:
corepack pnpm exec vitest run services/orchestrator/tests/acceptanceHardTier.test.ts
```

The test
(`services/orchestrator/tests/acceptanceHardTier.test.ts`) asserts:

- The worker **claims** the queued `plan` job and runs the workflow to a
  `completed` result with loop outcome `passed`.
- **Re-plan path:** the first `per_iteration` gate call fails, so the loop
  re-plans (`planner.rerequested`, gate-producer) instead of checking a
  known-broken tree.
- **Auditor-rejection path:** the auditor rejects once (`loop_to_planner`)
  before passing — observable as ≥ 2 `pre_audit` gate calls and a third
  planner invocation.
- **Conflict-resolution path:** the approved PR's first direct merge
  reports a conflict, the conflict-resolver hook fires exactly once, and
  the retried merge succeeds.
- **Coherent terminal state:** the run lands `done / ok` and the spec
  `merged` — not halted.
- **Bounded loops:** a companion case proves a never-satisfied checker
  halts as `retry_budget_exhausted` after exactly `maxPlannerRerunsPerSpec`
  re-plans, never running away.

## Live fixture-hard scenario (operator, through the dashboard)

This is the real-system replacement for the deleted `just acceptance-*`
recipes: instead of a script invoking the workflow directly, the operator
**triggers a run through the dashboard** and observes the hard paths in
the run timeline as the background worker executes it.

### What a `fixture-hard` repo must contain

Create a GitHub repo `cat-cave/tanren-fixture-hard` whose single spec is
**crafted to force all three hard paths** in one run:

1. **Forces ≥ 1 in-loop gate failure → re-plan.** The repo ships a
   `tanren-ci.yml` whose fast tier runs the unit tests, and the task is
   phrased so a naive first writer attempt leaves the tree failing that
   tier (e.g. a function whose new test the writer is likely to break or
   leave unimplemented on the first pass). A nonzero fast-tier exit routes
   the run back to the planner via `planner.rerequested` (producer `gate`)
   **before** any checker call.
2. **Forces ≥ 1 auditor rejection → rework.** The acceptance criteria
   include a cross-cutting behavior (e.g. "the public API is documented in
   the README _and_ exported from the package index") that a per-subtask
   checker can pass while the integrated result still misses it — so the
   auditor returns `loop_to_planner` at least once.
3. **Forces a merge conflict.** The fixture's base branch carries a commit
   that touches the same lines the run's branch will edit (e.g. a
   conflicting edit to the file the task changes), so the post-approval
   direct merge reports a 409 conflict and exercises the conflict-resolver
   hook. The project must be configured with `mergeIntegration:
"direct_merge"` for Tanren to attempt the merge (otherwise it hands off
   to a human and the conflict path is not reached).

### How the operator runs it

1. Bring up the dev stack **with the worker enabled**:

   ```sh
   TANREN_RUN_WORKER=1 just up-dev
   ```

   (Or set `TANREN_RUN_WORKER=1` on the orchestrator service; the worker
   is the only thing that dequeues `plan` jobs.)

2. Create the project for `cat-cave/tanren-fixture-hard` with
   `mergeIntegration: "direct_merge"` and the hard spec text, then
   **trigger the run from the dashboard** (Spec → Run). The trigger only
   enqueues a `plan` job; the worker claims and executes it.

3. Observe the hard paths in the **run timeline** (the same events the
   deterministic test asserts):
   - `gate.failed` (fast tier, `per_iteration`) → `planner.rerequested`
     (producer `gate`) — the re-plan fired.
   - a second `planner.rerequested` (producer `auditor`) after a
     `pre_audit` gate pass — the auditor-rejection rework fired.
   - `merge.conflict` followed by a successful `merge.completed` (the
     conflict resolver resolved it) — or, if the resolver cannot resolve,
     the run halts with the conflict surfaced on the recovery surface
     (still a coherent, recoverable terminal state).
   - the run reaches `done` and the spec `merged`.

If the resolver stub (P3-0008) cannot resolve the conflict, the run halts
recoverably with `merge.conflict` surfaced — this is the expected v0
behavior until a real conflict resolver lands, and the operator resolves
the conflict manually on the PR.

---

# Phase 2A Acceptance Gate (historical)

> **Note:** every `just acceptance` / `acceptance-easy` / `acceptance-medium`
> recipe and the `scripts/acceptance/{easy,medium}.ts` drivers described in this
> section were **deleted in P3-0001** (see the banner at the top of this file).
> The text below is preserved only as the record of how the Phase 2A gate worked;
> the recipes no longer exist. Use a worker-backed dashboard/API-triggered run to
> exercise a full workflow today.

`just acceptance` was the **executable Phase 2A release gate** owned by
P2A-0015. It ran the easy and medium fixture repos through the real
Tanren workflow end-to-end and asserted persisted outcome, PR URL, CI
status, and cost attribution. The gate was **local-only** — it never ran
in GitHub Actions because it called real Codex CLIs and created real draft
PRs against the fixture repos.

## Setup (once per machine)

The gate reads operator-supplied credentials and the target repo from a
single config file at the repo root. Stack-internal details
(Postgres URL, Vault address/token, SSH host/port/user/key, SSH host
fingerprint) come from the dev compose contract and are auto-discovered
or hardcoded — the operator never has to set them.

1. Bring up the dev stack:

   ```sh
   just up-dev
   ```

2. Copy the template config and fill in your absolute paths:

   ```sh
   cp tanren.acceptance.example.json tanren.acceptance.json
   $EDITOR tanren.acceptance.json
   ```

   The file is gitignored. Required keys:

   | Key                 | Meaning                                                                                                       |
   | ------------------- | ------------------------------------------------------------------------------------------------------------- |
   | `codex_auth_file`   | Absolute path to the Codex CLI auth.json bundle (from `codex login --device-auth`).                           |
   | `github_token_file` | Absolute path to a file containing a GitHub PAT (or App install token) with `repo` scope on the fixture repo. |
   | `github_repo_url`   | HTTPS URL of the fixture repository (`https://github.com/cat-cave/tanren-fixture-easy` for easy tier).        |

   Optional keys:

   | Key                  | Default | Meaning                          |
   | -------------------- | ------- | -------------------------------- |
   | `github_base_branch` | `main`  | Base branch on the fixture repo. |

3. Run the gate:

   ```sh
   just acceptance-easy     # easy tier
   just acceptance-medium   # medium tier (pending fixture-medium operator setup)
   just acceptance          # both
   ```

## What the gate auto-discovers

These details come from the running dev stack — operator never sets them:

| Detail                        | Source                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Postgres connection           | `postgres://tanren:tanren@127.0.0.1:5432/tanren` (compose.dev.yml)                |
| Vault address                 | `http://127.0.0.1:18200` (compose.dev.yml)                                        |
| Vault root token              | `dev-root-token` (compose.dev.yml)                                                |
| Runner SSH host / port / user | `127.0.0.1:2222` as `tanren` (compose.dev.yml)                                    |
| Runner SSH key path           | `/tmp/tanren_runner_key` (generated by `just up-dev` via the `runner-key` recipe) |
| Runner SSH host fingerprint   | Auto-discovered via `ssh-keyscan -p 2222 -t ed25519 127.0.0.1`                    |

For non-dev deployments (you're running against a non-default Postgres,
Vault, or SSH endpoint), override each value with the matching
environment variable; the script's defaults are documented in
`scripts/acceptance/config.ts`. Production deployment is Phase 3.

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

## Medium tier (pending operator setup)

`just acceptance-medium` currently validates the config and prints a
pending notice. To unblock the live runner, the operator pre-creates a
fresh GitHub repo `cat-cave/tanren-fixture-medium`, pushes the initial
content from `fixtures/acceptance-medium/` to it, and the live runner
code is landed in a follow-up commit.

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

## Config resolution order

The script looks for the operator config in this order; the first match wins:

1. `$TANREN_ACCEPTANCE_CONFIG` env var (explicit absolute path)
2. `./tanren.acceptance.json` at the repo root
3. `~/.config/tanren/acceptance.json`
4. **Legacy**: the original `TANREN_*` env vars from Phase 1 (emits a deprecation hint pointing at this doc)

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
costRecords     : 3 (write:subscription/unknown, check:subscription/unknown, audit:subscription/unknown)
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

| Symptom                                        | Likely cause                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `no acceptance config found` and exit 2        | Copy `tanren.acceptance.example.json` to `tanren.acceptance.json` and fill in.                                       |
| `ssh-keyscan 127.0.0.1:2222 failed`            | Stack is not up — run `just up-dev` first.                                                                           |
| `All configured authentication methods failed` | Stack was started without the runner key — bring it down (`just down-dev`) and back up with `just up-dev`.           |
| `Codex Answerer failed for schema ...`         | The Codex auth bundle is invalid or expired; re-run `codex login --device-auth` and update `tanren.acceptance.json`. |
| `pr_url is null` and exit 1                    | The Codex writer failed to commit; check task rows.                                                                  |
| `ci.passed event not present` and exit 1       | The fixture repo's CI failed; inspect the draft PR.                                                                  |
| `cost_records have unknown source rows`        | A new adapter bypassed `CostRecorder`; this is a release block (P2A-0011 invariant).                                 |
| `expected ≥ 1 planner.rerequested event`       | Medium spec was too easy; revise the spec text so the checker rejects the first attempt.                             |
