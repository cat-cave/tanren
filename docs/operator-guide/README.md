# Operator Guide

## What Tanren delivers

Tanren takes a spec to a merged, deployed, demoed change — through its **own native
delivery model**, against your real repository. The loop is
`spec → plan → write → check → audit → native gate → merge → deploy → demo`, driven
by the background run worker with real writer/answerer adapters. It is live-proven
on `main` across three governance tiers (easy / medium / hard, the hard one a
private repo), each to a merged PR with real Codex and real credentials.

**Delivery is Action-less.** Tanren does not inject a GitHub Actions workflow and
does not poll an external CI engine. The gate is Tanren's own: tiered shell checks
declared in the target repo's `.tanren/ci.yml` (a `CiConfigV1`, **not** an Actions
workflow), run over SSH on the runner workspace; the `pre_merge` tier is the merge
authority; the verdict publishes to the forge as a `tanren/gate` check. The VCS
stores code, hosts the PR review surface, and accepts the merge — it does not
orchestrate delivery. (Tanren's own monorepo CI runs on GitHub Actions like any
other repo; that is orthogonal to the delivery doctrine.)

The model in one picture:

| Conventional repo automation | Tanren-native equivalent             |
| ---------------------------- | ------------------------------------ |
| `.github/workflows/*.yml`    | native gate (`.tanren/ci.yml` tiers) |
| GitHub-hosted runner         | Tanren runner (SSH, per-run)         |
| Actions secrets              | scoped Tanren credentials            |
| deploy workflow              | `DeployAdapter` (deploy-on-merge)    |
| required status check        | `tanren/gate` published verdict      |
| marketplace action           | typed external integration           |

## The runbooks

- **`operator-driven-run.md`** — the full operator flow: sign in, create an org,
  import credentials, link a repo, submit a spec, trigger a run, watch it merge +
  deploy.
- **`ci-config.md`** — the native gate definition (`.tanren/ci.yml`).
- **`deploy.md`** — deploy-on-merge, `verify`, and demos-as-evidence.
- **`credentials.md`** / **`github-app.md`** / **`auth.md`** — credential import,
  the per-org GitHub App, and identity providers.
- **`costs.md`** — cost-as-fact (notional vs metered) and the budget gate.
- **`runners.md`** — the per-run runner substrate and isolation.
- **`acceptance.md`** — the §14 acceptance gate; **`live-validation-findings.md`**
  — what the three live tiers proved and the config gotchas.
- **`cli.md`** — the thin `tanren` CLI reference.

## Running the stack

Start with the local smoke:

```sh
corepack enable
corepack pnpm install
just smoke
```

`just smoke` builds the images, starts the compose stack, runs `tanren doctor` (orchestrator / Postgres / Vault connectivity), verifies direct runner SSH, runs the live SSH integration test, then drives the real run path across the API↔worker process boundary (`smoke-plane-split-*`, including the `42501` de-privilege proofs) and the RLS isolation proofs.

To inspect manually while the stack is up:

```sh
corepack pnpm --filter @tanren/cli tanren doctor
corepack pnpm --filter @tanren/cli tanren status <run_id>
```

`tanren status <run_id>` returns the run row, ordered planner/writer/checker/auditor tasks, events, and cost records.

## Live component proofs

With the compose stack up, the opt-in live proofs drive real Codex / GitHub against an owned fixture repo with real credentials (no fakes):

```sh
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token just live-github-draft-pr
TANREN_GITHUB_TOKEN_FILE=/path/to/github-token just live-ci-poll
TANREN_CODEX_AUTH_JSON_FILE=/path/to/auth.json just live-codex-writer
```

The full end-to-end live walkthrough across all three governance tiers — including the native-gate config per tier and the simulated reviewer for the human-review tier — is in `live-validation-findings.md`.

To clean up:

```sh
just compose-down
```

If you are moving from an older local database shape, reset the volume before running the smoke:

```sh
docker compose -f compose.dev.yml down -v
```

For prod deployment and the Vault init flow, see `deploy.md`.
