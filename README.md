# Tanren

Tanren is the platform for end-to-end agentic code development. You give it a
spec; it plans, writes the code with a real agent, checks and audits the result,
opens a draft PR, runs CI, reviews, and merges — against your real repository,
with honest cost accounting.

## Current state (read this first)

**Tanren delivers merged PRs from natural-language specs, live-validated across
three tiers with real Codex and real credentials.** The full loop —
`plan → write → check → audit → in-loop gate → draft PR → CI → review → merge` —
runs end-to-end through the background **run worker**, driven from the dashboard
or the `tanren` CLI, with no fake adapters anywhere in the runtime path.

Live-proven acceptance (the §14 gate — see `docs/operator-guide/acceptance.md`):

| Tier   | Repo        | Task                                                                                  | Result    |
| ------ | ----------- | ------------------------------------------------------------------------------------- | --------- |
| Easy   | public      | add a file                                                                            | merged PR |
| Medium | public      | implement functions so a committed test suite passes (two-tier CI: typecheck + tests) | merged PR |
| Hard   | **private** | implement real logic + rigorous CI + an **orchestrator-managed simulated PR review**  | merged PR |

Each tier was driven by a real operator flow: sign in → create an org → import
real provider credentials → link a repo → submit a spec → trigger a run → watch
it merge. **Private repositories work** (the workspace clone authenticates with
the org's GitHub token over HTTPS). All three of the project's cost models, the
event log, and full run/task provenance are persisted and inspectable.

### What's built and merged on `main`

- **The agentic run loop**, real end-to-end: the run worker
  (`services/orchestrator/src/engine/worker/`) dequeues `plan` jobs and drives
  the full loop with real writer/answerer adapters (Codex/Claude/opencode behind
  a versioned harness protocol). No fake adapter is reachable from production
  source — fakes live only in `tests/`.
- **Per-project, tiered integration policy** — `governancePosture`
  (`strict`/`open`/`audit_only`), `mergeIntegration`
  (`native_queue`/`direct_merge`/`external_reviewer`/`not_configured`), and
  `reviewPolicy` (`human`/`auto`/`simulated`). The **simulated reviewer** is an
  orchestrator-managed Answerer that judges the PR diff against the spec and
  posts a real GitHub review, so the human-review path runs end-to-end in testing
  without a human.
- **The operator product** — dashboard (DAG canvas, thick-Forge conversation,
  spec discovery, candidate inbox, scheduled audits, `tanren-config` gate,
  greenfield + brownfield onboarding), the thin `tanren` CLI, SSH runner
  substrate, the allocator family (static/sidecar/manual-ssh/Hetzner/
  DigitalOcean/GCP/AWS-EC2/Kubernetes), pluggable secret stores
  (Vault/GCP-SM/AWS-SM/1Password), multi-provider identity
  (github_oauth/OIDC/Authentik/local_dev), per-org GitHub App connectivity, all
  nine notification channels, a quota/admission + metering seam, and a
  BYOK-vs-managed provider toggle.
- **Multi-tenancy, fully DB-enforced + live-validated.** Postgres Row-Level
  Security enforces `org_id` isolation — a restricted `tanren_app` runtime role
  (NOBYPASSRLS), a narrow `tanren_system` BYPASSRLS pool for bootstrap/cross-org
  reads, deny-by-default `USING`+`WITH CHECK` policies on every tenant table
  (`db/src/orgScope.ts`; migrations `0029`/`0030`).
- **Control-plane / data-plane split, P1 → P3c.** A standalone `worker`
  deployable claims jobs over an mTLS control-plane endpoint and routes **every**
  run-state write — events, cost records, **and the run/spec/task lifecycle
  writes** — through control-plane `/internal/*` endpoints. It connects as the
  de-privileged `tanren_dataplane` role whose `events`/`cost_records` (migration
  `0031`) and `runs`/`specs`/`tasks` (migration `0035`) write grants are dropped,
  proven by `42501` negative tests. The standalone **allocator** service is
  org-threaded and writes `runners` rows under RLS too.
- **The tanren-method benchmark toolkit** — a first-class capability for
  measured process-tuning. Experiment/cell/trial entities, a `TrialScorecard`
  projection, `deriveCellScorecard` / `compareCells` reducers (bootstrap CI +
  Mann–Whitney), a `BenchmarkRunner` that schedules trials through the real run
  worker, a post-merge hidden-`accept` step, and `tanren experiments` / `tanren
cells` CRUD + `report` / `compare`. See `docs/roadmap/tanren-method-benchmark.md`.
- **A data-access layer** behind a conformance-covered `Repositories` seam
  (`engine/repositories/**`, `engine/contracts/repositories.ts`); the HTTP routes
  and the run-lifecycle writes are migrated off raw SQL.
- **Quality bars** — `LISTEN/NOTIFY` (no 1s polling), conformance suites for
  Allocator / JobQueue / EventStore / SecretStore / CostResolver / Repositories,
  ~13 Stryker mutation clusters + a weekly full-repo job (`mutation-weekly.yml`),
  oxlint warnings driven to ~5 with ~25 rules flipped warn→error, and a hardened
  15-step strictness gate.

### What is still ahead

The forward plan (near- and long-term) lives in **`docs/roadmap/tempering.md`**
(the live tracker) and **`docs/roadmap/forward-roadmap.md`** (the detailed
four-dimension plan).

The **largest remaining effort is the autonomy engine** —
**`docs/roadmap/autonomy-engine.md`**. **Phase 1 — the autonomy core — is merged
on `main`** (PRs #220–#226): Tanren now drives its own spec graph. The autonomous
**DAG-walker**, persisted **priority**, **real-LLM Forge** (the deterministic
answerers moved to `tests/fixtures/`), **webhook-first issue intake**, a
**stub-ban architecture lint** (`no-production-stubs`), and a **real-resource
`just e2e` gate** all landed — and `QuotaPolicy` is deleted (budget is the only
run gate). The manual per-spec trigger and the templated ideation stubs are gone.

**Phase 2 — native merge coordination — is the active next build**: because the
live DAG-walker runs specs in parallel, they now collide, so a `VcsProvider` seam
→ auto-rebase → DAG-aware **intent-preserving conflict resolution** → speculative
execution + change-percolation → a **native merge queue** (then Mergify removed).
**Phase 3** proves the whole thing with **`apex`**, a max-difficulty fixture that
takes a one-paragraph brief to a deployed product autonomously.

Smaller near-term items: **Vault per-run scoped credentials** (the last big
data-plane de-privilege), the **benchmark seed corpus**, the **remaining DAL
clusters** (forge/recovery — quota is gone); long-horizon: the GitLab/VCS
abstraction and the Rust rewrite / native harness. None of these block the core
promise above.

## Quickstart for a real run (operator flow)

```sh
corepack enable
pnpm install
just up-dev                       # brings up Postgres, Vault, orchestrator, worker, allocator, runner, dashboard, ntfy
```

Then, through the dashboard (`http://localhost:3000`, or your `DASHBOARD_HOST_PORT`)
or the `tanren` CLI: sign in, create an org, import your provider + GitHub
credentials, link a repo, submit a spec, and trigger a run. The full runbook is
**`docs/operator-guide/operator-driven-run.md`**; the CLI reference is
**`docs/operator-guide/cli.md`**; credential import is
**`docs/operator-guide/credentials.md`**.

> **Fresh DB.** Migration `0026` makes `org_id` NOT NULL on the core tables; a
> volume created before it can't be backfilled in place. Start clean with
> `just down-dev` (removes volumes) then `just up-dev`. Volume wipes are expected
> — Tanren has no legacy-data compatibility surface.

## Local Smoke

```sh
corepack enable
pnpm install
corepack pnpm run check
just smoke
```

`just smoke` builds the orchestrator, dashboard, and runner images, starts the
stack, and verifies:

- `smoke-connectivity` — `tanren doctor` (orchestrator / Postgres / Vault) +
  direct runner SSH reachability.
- `smoke-ssh-integration` — the real SSH substrate.
- the real run path across the API↔worker process boundary
  (`smoke-plane-split-*`, including the P3b/P3c `42501` de-privilege proofs).
- the RLS isolation proofs (`smoke-rls-*`, including `smoke-rls-allocator`).

There is no synthetic `hello` workflow — it was purged from the runtime; the
smokes above exercise the real boundaries. The opt-in component live proofs
(`just live-codex-*`, `live-github-draft-pr`, `live-ci-poll`) drive real Codex /
GitHub against an owned fixture repo with real credentials.

To tear down: `just compose-down` (alias for `just down-dev`, which removes
volumes).

## Roadmap & source of truth

- **`PROJECT_BRIEF.md`** — the durable vision and architectural invariants (the
  source of truth for _what Tanren is_).
- **`docs/roadmap/tempering.md`** — the live forward tracker: what's done, what's
  next (near- and long-term), and how a fresh clone reproduces the validated state.
- **`docs/roadmap/autonomy-engine.md`** — the plan for the largest remaining
  effort: making the DAG autonomous (DAG-walker · real-LLM Forge · native merge
  queue · the `apex` proof) + the stub-ban + real-e2e guardrails.
- **`docs/roadmap/forward-roadmap.md`** — the detailed four-dimension plan (core
  run loop · pipeline experimentation · refactor/scale prepwork · managed-hosting).
- **`ROADMAP.md`** — the phase history (Phase 0–3) + exit criteria.
- **`docs/operator-guide/`** — operator runbooks (run, credentials, CLI, CI
  config, deploy, acceptance, costs, auth, …).
- **`CLAUDE.md`** / **`AGENTS.md`** — orientation for agents working in the repo.
