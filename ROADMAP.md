# ROADMAP

The single consolidated roadmap for Tanren — current state, phase history, the
durable architecture posture, and the live forward to-do. This file supersedes
the former `docs/roadmap/*` planning docs (all folded in here and deleted). The
durable product vision lives in `PROJECT_BRIEF.md`; the quickstart lives in
`README.md`; the architecture seams are documented under `docs/architecture/`
and the operator how-to under `docs/operator-guide/`.

---

## 1. Current state

**Tanren turns specs into merged PRs — autonomously — running each unit of work
per-PR through real CI.** Phases 0–3 are built and merged, and the run loop is
live-validated end-to-end across easy / medium / hard tiers (the hard one a
private repo), each reaching a merged PR with real Codex and real credentials.
The autonomy engine (Phases 1 and 2) is merged: the DAG drives itself and the
native intelligent merge queue coordinates merges. The only remaining major
effort is **Phase 3 — `apex`** (§4), the live-validation vehicle that takes rough
operator notes to a deployed product autonomously.

### v21 native delivery (the current doctrine)

Delivery is **Action-less**. The native shell-tier gate — `.tanren/ci.yml`, a
`CiConfigV1`, **not** a GitHub Actions workflow — runs over SSH and is the **sole
merge authority**; the `pre_merge` tier admits the merge and the verdict
publishes back to the forge as the `tanren/gate` commit status. There is no
injected Actions workflow, no `runs-on: tanren`, and no external CI in the
delivery path. (Tanren's own monorepo CI runs on GitHub Actions like any other
repo; the no-Actions doctrine governs the delivery path for the apps Tanren
_builds_.) The dead GitHub-Actions delivery path was pruned; `engine/ci/yaml.ts`
emits no workflow YAML; the cutover is **unconditional** (no `merge_gate_source`
config knob). See `docs/operator-guide/ci-config.md`.

The shape of the platform today:

- **Mergify is fully removed.** `native_queue` is the merge engine; the merge
  CTAs are `direct_merge | native_queue | external_reviewer | not_configured`.
- **Migrations are collapsed** to a single baseline — `db/migrations/` holds
  `0000_collapsed_baseline.sql` plus only the events added since. Old
  numbered-migration citations in prose are dead pointers; restate any
  schema reference against the collapsed baseline + `db/src/schema*.ts`.
- **Status vocabulary is unified** to a single canonical run/spec/task vocab in
  `engine/state/`; a successful run ends at `completed` (no second `done`).
- **Vault per-run scoped credentials are done** — `vaultTokenMinterImpl.ts` mints
  an orphan child token with a per-ref ACL; the `dev-root-token` fallbacks are
  removed from `main.ts` + `allocator/main.ts` (broad token REQUIRED, fail-hard).

---

## 2. Phase history (frozen)

### Phases 0–3 — the v0 build

- **Phase 0 — Kernel** (done). Type-checked Drizzle schema as the single source
  of truth; the SSH execution substrate; the local Docker allocator; a durable
  run/spec/task loop; a fake writer mutating a real git workspace in the runner.
  Exit: the orchestrator captures real diff/commit metadata across the runner
  boundary, with state durable enough for later async real-agent work.
- **Phase 1 — Real-Agent PR Loop** (done, live-proven). A persisted spec for an
  owned fixture repo runs a real Codex Writer in a runner workspace, uses
  structured Codex Answerers for check/audit, opens a draft PR, observes CI, and
  is inspectable through durable state. Codex was the first real CLI; Claude and
  opencode followed as additional Writers and Claude as the second Answerer.
- **Phase 2 — Operator-Controlled Workflow** (done). 2A delivered the operator
  backend + contracts (orgs/users/GitHub-OAuth + OIDC interface; typed workflow
  state; versioned project config with 6-role fallback-chain routing; event
  payload + Answerer schemas; redaction-on-read; allocator isolation; mandatory
  cost records; planner feedback loops; the Forge data substrate; the
  notifications matrix schema; product entities; workflow insights). 2B delivered
  the operator dashboard (shell + ⌘K palette, onboarding + credentials,
  chat-primary project view, run detail + review handoff, history + costs,
  failure recovery) and the first operator-driven live run.
- **Phase 3 — v0 Completion** (done, merged). The Tier-1 foundational vertical
  slice (the run worker that closes the loop, `TANREN_RUN_WORKER=1`) plus the
  Tier-2 expansion: review/merge with per-repo configurable integrations,
  two-tier in-loop gate-checks, the thick-Forge LLM backend, spec DAG canvas,
  spec discovery, full greenfield + brownfield onboarding, the `tanren-config`
  audit gate, subscription-window heatmap + DORA, live preview deploys, demo-role
  LLM wiring, additional workflow insights, scheduled audits, issue-source
  ingestion, external-push governance posture, provider expansion (Claude,
  opencode-Zai, aider), all nine notification channels, the acceptance hard tier,
  the allocator family (static/sidecar/manual-ssh/Hetzner/DigitalOcean/GCP/
  AWS-EC2/Kubernetes), CI/queue hardening, observability, and Authentik OIDC.

The full real loop — `plan → real-agent write → check → audit → in-loop gate →
draft PR → CI → review → merge` — was live-validated to a **merged PR across three
tiers**: easy (`open` / `direct_merge` / `auto`), medium (same + a two-tier
`.tanren/ci.yml`), hard (same + `reviewPolicy: simulated`, an orchestrator-managed
reviewer that posts a real GitHub review and drives the verdict internally; the
hard tier is a **private** repo). See
`docs/operator-guide/live-validation-findings.md`.

### Autonomy engine — Phases 1 and 2 (merged)

The plan to make the DAG self-driving (full design rationale:
`docs/architecture/autonomy-engine.md`).

- **Autonomy Phase 1 — the autonomy core** (PRs #220–#226). The autonomous
  **DagWalker** (`engine/dag/walker.ts`) drives the spec graph with no per-spec
  trigger; persisted spec **priority**; **real-LLM Forge** (`forge_llm` author;
  propose→approve→execute via `forge_action_proposals` + `routes/forge/{ask,
proposals}.ts`; the deterministic answerers moved to `tests/fixtures/`);
  **webhook-first autonomous intake**; the **stub-ban lint** (`no-production-stubs`,
  whose allowlist now has a single entry, `StubChannel`); and the real-resource
  `just e2e` gate. **`QuotaPolicy` is deleted — budget is the only run gate.**
- **Autonomy Phase 2 — native merge coordination** (PRs #228–#236). The
  **`VcsProvider` seam** + conformance, **auto-rebase**, **DAG-aware
  intent-preserving conflict resolution** (`engine/workflow/reviewMerge/
conflictResolver/`, a real resolver — `noopConflictResolver` retired),
  **speculative execution + change-percolation**, the **native intelligent merge
  queue** (`engine/merge/coordinator.ts` — DAG-order serialized merge +
  speculative batch-check + bisect), **CI-intelligence parity** (flaky-quarantine
  · CI analytics · queue stats), and **Mergify removed entirely**. Each unit was
  adversarially verified before merge.

> **Note (historical).** Earlier phase plans referenced "Mergify stacks" as the
> branch/PR coordination model and recommended `mergify stack sync` / `stack push`
> for dependent work. **That guidance is superseded:** Mergify was removed and
> `native_queue` is the merge engine. Parallel work today runs in isolated git
> worktrees, one unit per PR. One further dev-practice lesson from the Phase-2B
> build survives: **parallel agents must NOT all extend a single
> `OrchestratorClient`** — divergent private helpers + duplicate methods force a
> painful integration pass; give each parallel client-touching surface its own
> `api/*` module up front.

### SaaS hardening — RLS, plane-split, Vault scoping (merged + live-validated)

- **Row-Level Security**, fully DB-enforced + live-validated: a restricted
  `tanren_app` runtime role (NOBYPASSRLS), a narrow `tanren_system` BYPASSRLS pool
  for bootstrap/cross-org reads, deny-by-default `USING` + `WITH CHECK` policies on
  every tenant table (`db/src/orgScope.ts`). A query off the org-scoped client
  sees **zero** rows.
- **Control-plane / data-plane split, P1 → P3c.** A standalone `worker` deployable
  claims jobs over an mTLS control-plane endpoint and routes **every** run-state
  write — events, cost records, **and** the run/spec/task lifecycle writes —
  through control-plane `/internal/*` endpoints; it connects as the de-privileged
  `tanren_dataplane` role whose write grants on those tables are dropped, proven
  by `42501` negative tests. The standalone **allocator** service is org-threaded.
- **Vault per-run scoped credentials** — the last big de-privilege. Before a run
  touches a credential, a per-run orphan child token scoped to exactly that run's
  cred paths backs the run's `SecretStore`; the `dev-root-token` fallbacks are
  removed (broad token REQUIRED, fail-hard).

---

## 3. Architecture posture (durable)

The durable design decisions Tanren is built to keep. The deeper rationale for
the autonomy engine — the speculation-threshold + change-percolation design, the
stub-ban + real-e2e guardrails, the intent-preserving conflict resolution, the
apex intent, and the usage-based billing principle — lives in
`docs/architecture/autonomy-engine.md` (the doc the in-code `§`-anchored comments
cite). The 10 → 1M north-star is `docs/architecture/future-refactor-and-scale.md`.

- **Clean adapter seams behind contracts + conformance suites.** Allocators,
  inbox source connectors, agent-harness adapters, notification channels, identity
  providers, secret stores, cost resolvers, the `Repositories` DAL, and the
  `VcsProvider` are each a contract with a conformance suite. Adding a backend is a
  new impl + a registry entry, never a refactor. The full Track-A expansion is
  shipped: every adapter family above has real implementations (e.g. all nine
  notification channels, the eight-strong allocator family, Vault/GCP-SM/AWS-SM/
  1Password secret stores, github_oauth/OIDC/Authentik/local_dev identity).
- **The `VcsProvider` seam is shipped** (`engine/contracts/vcsProvider.ts`,
  `engine/providers/{buildVcsProvider,githubVcsProvider}.ts`, conformance suite).
  Delivery is already native — the merge queue is Tanren's own and the gate runs
  over SSH publishing a `tanren/gate` check (no Mergify, no Actions) — so the only
  residual GitHub coupling is the thin VCS surface the seam abstracts: PR/review
  APIs, check/status publication, merge-accept, and clone/push auth. A second
  backend (GitLab/Gitea) is a new `VcsProvider` impl, held until a real
  second-backend requirement exists (§5).
- **The strictness & testing ladder is the standing quality posture.** The gate is
  a 15-step `just fast-check` (format-check, lint, types-lint, architecture,
  schema/state/event/answerer/contract drift, knip, spelling, typecheck, test,
  compose-config) with coverage floors + structural ratchets; oxlint warnings were
  driven to ~5 (~25 rules warn→error); ~13 Stryker mutation clusters plus a weekly
  full-repo job. Stubs/shells/mocks are test-fixtures-only, mechanically enforced
  by `no-production-stubs`.
- **Cost is fact.** `engine/costs/sources.ts` has **no** hardcoded price table;
  notional rates source from a vendored LiteLLM snapshot (`pricing/model_prices.json`
  - `modelPriceSource.ts`, refreshed via `just refresh-model-prices`); metered real
    spend comes from the provider's metering backend; the figure is NULL-loud when
    unattributable. **Budget is the only run gate** — a single total dollar ceiling as
    a project/org config knob (never an env var), enforced by the DagWalker, emitting
    `dag.budget.paused`. The forward cost-dimension design (itemized per-dimension
    budgets) lives in `docs/roadmap/budget-model.md`.
- **Integration provisioning — the two-plane model.** An operator grants
  high-level org/workspace access once and Tanren provisions/discovers/binds every
  project-level leaf resource itself (the `IntegrationProvisioner` port + registry
  - `org_integrations`; Sentry/Slack/Fly/Vercel provisioners + the Hetzner
    allocator are shipped). Plane A is the integrations Tanren uses; Plane B is the
    app environment the built product needs, injected over SSH
    (`engine/ssh/appEnvPrelude.ts`) — **never** as Actions secrets (under v21 there
    is no `setActionsSecret`). The design-of-record is
    `docs/operator-guide/integration-provisioning.md`.
- **`LISTEN/NOTIFY` is the event substrate** (`routes/runs/sse.ts`,
  `eventStore.ts`, `db/src/notify.ts`, channel `tanren_run`) — it replaced 1s
  polling. The autonomy layer reacts to `run.*` / `merge.completed` events on this
  bus rather than polling internal state.

---

## 4. What is next (the live to-do)

- **Phase 3 — `apex`** (the only remaining major effort). The max-difficulty
  live-e2e fixture: a single paragraph of rough operator notes → a deployed product
  (URL shortener + per-link analytics + a Slack bot + a web UI), built
  autonomously over real surfaces, every change a merged PR with full provenance.
  apex tests **Tanren**, not the fixture: the driver acts as a non-technical end
  user over the HTTP API + dashboard only, files real issues into Tanren for every
  defect, and never hand-fixes the generated repo. The operator contract is
  `docs/operator-guide/apex.md` and the live-run setup exists; it spends real
  credits under the $50 ceiling on already-provisioned Tier-1 creds. It is the
  **active live-validation vehicle**, not a not-yet-started milestone.
- **Benchmark seed corpus.** The tanren-method benchmark toolkit is code-complete
  (`engine/benchmark/**` — runner, scorecard, reducers, accept, store, stats;
  experiments routes; `tanren experiments`/`cells` CLI). What remains is the
  **content**: tiered seed repos + hidden content-addressed `accept` tiers + the
  experiments themselves, run across the corpus to pre-tune Tanren's default knobs.
  See `docs/roadmap/tanren-method-benchmark.md`.
- **Remaining DAL clusters.** Two forge stores still issue raw SQL —
  `engine/forge/audits/store.ts` and `engine/forge/inbox/store.ts` — and should
  move onto the `Repositories` seam (restate against the collapsed baseline, not
  old migration anchors). Plus `typify → serde` codegen (share the neutral
  JSON-Schema with a future Rust impl) and the first whole-repo `mutation-full`
  baseline (the recipe + weekly job exist; capture the first full-repo number +
  add the dashboard/routes clusters).
- **Residual hardening.** A few surviving Tier-2 backcompat items on a zero-users,
  single-baseline codebase: `schemaCore.ts` `.default('{}'::jsonb)` (a latent-500
  source) and the `resolveCredentials.ts` `orgId === ''` BYOK branch (a live path
  mislabeled "legacy" — make it a first-class named mode or remove it).

---

## 5. Held / long-horizon (explicit triggers, not the calendar)

- **GitLab / VCS beyond the thin `VcsProvider` surface.** The seam already shipped
  (§3); the Mergify/Actions coupling that previously justified deferring this is
  gone. A second backend is a new `VcsProvider` impl, built when a real
  second-backend requirement exists.
- **agy / pi / reasonix live-harness validation.** pi/reasonix writer-only
  adapters are built; agy is deferred (broken headless). Awaits credentials.
- **The Rust rewrite / native harness.** Long-horizon. The prepwork —
  contracts-as-durable-asset (behavior + conformance tests, neutral JSON-Schema,
  the harness protocol, mutation testing) — is the durable asset. Trigger: an
  observed scale bottleneck (single Postgres, the `SKIP LOCKED` queue, the SSH
  substrate, SSE fan-out), not a guess.
- **Vault as first-class compose hardening** + rotating the DEV/CI default role
  passwords out-of-band for prod (`docs/operator-guide/deploy.md`).

---

## 6. Validation cadence

- **`just smoke`** proves the real boundaries with no real credentials:
  connectivity (`tanren doctor` + runner SSH), the SSH substrate, the API↔worker
  plane-split `42501` de-privilege proofs, and the RLS isolation proofs. There is
  no synthetic `hello` workflow — it was purged.
- **`just e2e`** is the real-resource, real-credential gate (opt-in / nightly /
  pre-release — never on the per-PR fast path; it spends real credits). It drives
  the real operator flow against real fixtures and asserts on real persisted
  artifacts (a merged PR, the implemented file on the base branch, `cost_records`
  rows with real basis, the DORA projection). See `docs/operator-guide/e2e.md`.
- **The Tier-1 live-validation loop** is `apex` (§4): real GitHub App + Slack + a
  deploy target, already provisioned, spending real credits under the $50 ceiling.
  The credentials inventory + where they live is in
  `docs/operator-guide/validation-credentials.md`; the operator contract is
  `docs/operator-guide/apex.md`.

To reproduce the validated state from a fresh clone: `just up-dev` (fresh DB),
onboard via the dashboard or CLI (`docs/operator-guide/operator-driven-run.md`),
import real Codex/GitHub creds through the org-scoped surface, link a fixture
repo, set the project config for the tier, submit a spec, and watch it reach a
merged PR. The three fixtures used for the live proof are
`cat-cave/tanren-fixture-{easy,medium,hard}`; the walkthrough + config gotchas are
in `docs/operator-guide/live-validation-findings.md`.

---

## 7. Beyond apex — dogfooding & the update problem

apex proves the **greenfield** loop. The horizon past it is **Tanren building
Tanren**: brownfield change against this monorepo, the interactive/UX surface that
the API-only apex driver can't reach, and the self-update question apex never asks
(how a running Tanren adopts a merged change to its own code without bricking
itself). The bridge fixtures (brownfield-apex → UX e2e → self-change), the
two-loop self-update model, and the deployer-can't-brick-itself rule are designed
in **`docs/roadmap/dogfooding.md`**. How a team should _drive_ this repo with
parallel agents (the orchestration discipline behind every PR above) is
**`docs/playbooks/parallel-orchestration.md`**.
