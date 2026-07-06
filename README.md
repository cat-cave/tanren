# Tanren

Tanren is the platform for end-to-end agentic code delivery. You give it a spec;
it plans, writes the code with a real agent, checks and audits the result, gates
the merge with its **own native checks**, merges, and then deploys the change and
runs a demo against the live surface — against your real repository, with honest
cost accounting.

**Tanren is opinionated about the method, not the product.** You choose what you
build, the language and framework, which LLMs do the work, the deploy target, and
how much human review is required. Tanren owns the delivery operating model:
software is specified, built, gated, merged, deployed, and demoed through
Tanren-native concepts — never through repo-embedded workflow automation.

**Delivery is Action-less.** There is no injected GitHub Actions workflow, no
`runs-on: tanren`, no external CI engine in the delivery path. The gate is
Tanren's own: tiered shell checks run over SSH on the runner workspace; the
`pre_merge` tier is the merge authority; verdicts publish back to the forge as
`tanren/gate` checks. The VCS stores code, hosts the PR review surface, and
accepts the merge — it does not orchestrate delivery. (Tanren's own monorepo CI
is a separate concern, and runs on GitHub Actions like any other repo; the
no-Actions doctrine governs the delivery path for the apps Tanren _builds_.)

## Current state (read this first)

**Tanren delivers merged PRs from natural-language specs, live-validated across
three governance tiers with real Codex and real credentials.** The loop —
`spec → plan → write → check → audit → native gate → merge → deploy → demo` — runs
through the background **run worker**, driven from the dashboard or the `tanren`
CLI, with no fake adapters anywhere in the runtime path. The single-spec → merged-PR
path is live-proven across all three tiers (including a private repo); the
**autonomous, multi-PR, deploy-the-whole-product** close is built and merged but not
yet proven on a live run — see the honest proof state further down.

Live-proven acceptance (the §14 gate — see `docs/operator-guide/acceptance.md`):

| Tier   | Repo        | Task                                                                                  | Result    |
| ------ | ----------- | ------------------------------------------------------------------------------------- | --------- |
| Easy   | public      | add a file                                                                            | merged PR |
| Medium | public      | implement functions so a committed test suite passes (two-tier CI: typecheck + tests) | merged PR |
| Hard   | **private** | implement real logic + rigorous CI + an **orchestrator-managed simulated PR review**  | merged PR |

Each tier was driven by a real operator flow: sign in → create an org → import
real provider credentials → link a repo → submit a spec → trigger a run → watch
it merge. **Private repositories work** (the workspace clone authenticates with
the org's GitHub token over HTTPS). The merge is admitted by Tanren's own
`pre_merge` gate — not an Actions check. All three of the project's cost models,
the event log, and full run/task provenance are persisted and inspectable.

**What is _not_ yet proven.** The full **autonomous** loop — rough operator notes →
DAG → many merged PRs → a live deploy → a working product, closed end-to-end without
a human in the inner loop — has **not** yet closed on a live run. That is the open
edge `apex` (below) drives. The three-tier acceptance above is a single spec → a
single merged PR per tier; the autonomy engine that strings many of those together
into a whole product is built and merged, but its end-to-end close is still the
live-validation target. Read the state below honestly: the engine is the single
live path; the proof that it carries a product over the finish line is pending.

### What's built and merged on `main`

- **The agentic run loop**, real end-to-end: the run worker
  (`services/orchestrator/src/engine/worker/`) dequeues `plan` jobs and drives
  the full loop with real writer/answerer adapters (Codex/Claude/opencode behind
  a versioned harness protocol). No fake adapter is reachable from production
  source — fakes live only in `tests/`.
- **The native gate is the merge authority** — no GitHub Actions in the delivery
  path. `.tanren/ci.yml` (a `CiConfigV1`, not an Actions workflow) declares tiered
  shell checks; the orchestrator runs them itself over SSH on the runner workspace
  (`engine/workflow/gate/runGateTier.ts`), and the `pre_merge` tier admits the
  merge. The verdict is published to the forge as a `tanren/gate` check
  (`engine/workflow/plannerRunCi.ts`); a JUnit report the gate produces is ingested
  in-process for flaky-detection (no upload, no webhook, no signing secret). See
  `docs/operator-guide/ci-config.md`.
- **Deploy + demo as native delivery stages.** A `DeployAdapter`
  (`engine/contracts/deployAdapter.ts`) provisions-or-binds a deploy target,
  triggers a deploy on merge (`engine/postMerge/deployOnMerge.ts`), and `verify`
  polls the provider to READY + smoke-checks the URL. The **demo engine**
  (`engine/demo/`) then exercises the spec's declared behaviors against the live
  surface and records per-behavior evidence (demos-as-evidence) — the demo asks
  whether the behavior is correct; the adapter decides whether the user sees a
  URL, package, app channel, or download. See `docs/operator-guide/deploy.md`.
- **Brownfield workflow-intent migration.** Onboarding an existing repo reads its
  `.github/workflows/`, package scripts, and branch protection and migrates the
  _intent_ — not the YAML — into native gates, emitting a **migration-risk report**
  (`engine/forge/brownfield/`) that classifies each discovered automation as
  migrated / replaced / dropped / blocked. Unsupported behavior becomes an
  auditable risk, never a preserved Actions workflow.
- **Audit-evidence + security baseline in the event store.** Every governing
  delivery decision (gate verdict, deploy, merge) carries a non-secret audit
  envelope — initiating + approving actor, governance policy version — appended
  through the single typed event path (`engine/events/schemas/audit.ts`). No
  secret value ever enters an event payload.
- **Named execution-backend substrate seams.** The backend differences are
  explicit contracts — `CommandSubstrate` / `FileSubstrate` /
  `CredentialMaterializer` / `UsageMeter` / `ReleaseFinalizer` /
  `RunnerHandle` (`engine/contracts/`) — so a future non-SSH backend slots in as a
  new impl, not a refactor.
- **A unified status vocabulary** — one canonical run/spec/task status enum
  (`engine/state/`); a successful run ends at `completed` (no second `done`),
  so every producer and consumer reads the same vocabulary.
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
  nine notification channels, a budget gate + metering seam (no quotas), and a
  BYOK-vs-managed provider toggle.
- **Multi-tenancy, fully DB-enforced + live-validated.** Postgres Row-Level
  Security enforces `org_id` isolation — a restricted `tanren_app` runtime role
  (NOBYPASSRLS), a narrow `tanren_system` BYPASSRLS pool for bootstrap/cross-org
  reads, deny-by-default `USING`+`WITH CHECK` policies on every tenant table
  (`db/src/orgScope.ts`; the roles + policies live in the collapsed baseline).
- **Control-plane / data-plane split, P1 → P3c.** A standalone `worker`
  deployable claims jobs over an mTLS control-plane endpoint and routes **every**
  run-state write — events, cost records, **and the run/spec/task lifecycle
  writes** — through control-plane `/internal/*` endpoints. It connects as the
  de-privileged `tanren_dataplane` role whose `events`/`cost_records` and
  `runs`/`specs`/`tasks` write grants are dropped, proven by `42501` negative
  tests. The standalone **allocator** service is org-threaded and writes
  `runners` rows under RLS too.
- **The tanren-method benchmark toolkit** — a first-class capability for
  measured process-tuning. Experiment/cell/trial entities, a `TrialScorecard`
  projection, `deriveCellScorecard` / `compareCells` reducers (bootstrap CI +
  Mann–Whitney), a `BenchmarkRunner` that schedules trials through the real run
  worker, a post-merge hidden-`accept` step, and `tanren experiments` / `tanren
cells` CRUD + `report` / `compare`. See `docs/roadmap/tanren-method-benchmark.md`.
- **A data-access layer** behind a conformance-covered `Repositories` seam
  (`engine/repositories/**`, `engine/contracts/repositories.ts`); the HTTP routes,
  the run-lifecycle writes, and the former raw-SQL forge stores (audits + inbox →
  `engine/repositories/{audits,inbox}.ts`) are migrated off raw SQL.
- **No arbitrary timeouts, retry caps, or wall-clock deadlines — anywhere.** The
  explicit timeout/retry-cap family is **eradicated and CI-gated**. Every
  hang-detection mechanism is **progress / sign-of-life** based: an `ActivityWatchdog`
  (`engine/ssh/activityWatchdog.ts`) kills only on evidence of death (no advance in
  output / tokens / CPU / workspace-mtime, with a structural probe backstop), and
  `retryUntilConverged` (`engine/workflow/retryUntilConverged.ts`, wrapping
  `convergenceDetector`) replaces every `MAX_*` / `maxPolls` give-up with intelligent
  non-convergence detection (same failure + no progress → escalate, never a counter).
  A working agent runs **unbounded**. The `scripts/check-architecture-timeouts.mjs`
  lint is CI-gating. **Note:** apex v44/v45 surfaced two disguised survivors the
  initial lint missed — the ssh2 `timeout:` socket idle-timeout (#638) and a
  newest-mtime liveness probe a lock-heartbeat defeated (#640); both are fixed and the
  lint extended. apex v49 surfaced a third doctrine extension — task #21: derive's
  synchronous wait on the template-build child run had no inner-failure circuit
  breaker, so a downstream stall presented as an 8-hour curl hang. Both fixes have
  landed — #21A (runner-INSERT idempotency) shipped as PR #705, and #21B was
  OBVIATED by PR-F #693 (templating collapsed to fragment-only composition; the
  template-build child run + its synchronous-wait surface no longer exist). PR #702
  further extended the enforcement lint to close the audit-#672 evasion paths. The
  doctrine stands; disguised survivors are caught and fixed (or obviated) as found.
  See `docs/roadmap/timeout-eradication.md`.
- **A native DESIGN subsystem — Tanren owns design the way it owns the engine.** A
  domain-general, persisted, versioned `DesignContract` (`engine/design/`) is
  authored by a native design agent + design phase, **injected into the writer on
  every generation** (no decorative `designDna` hint), and verified by a domain-aware
  **design oracle** (`engine/workflow/designOracle/`) whose findings re-drive the
  writer in the **same DAG, no handoff seam**. The moat: design binds to first-class
  personas (strict resolution, no guessing) + behaviors (exhaustive coverage). It is
  built + wired end-to-end (WS-D1..D4) but **not yet exercised on a live run with a
  captured contract** — that is a scoped exercise for the next apex run (visual
  pixel-fidelity is the WS-D4a follow-on). See `docs/roadmap/native-design-subsystem.md`.
- **Cost as fact, with a budget gate.** Token accounting is mandatory; dollar cost
  is sourced — **notional** figures rate from LiteLLM `model_prices`, **metered
  real spend** comes from the provider's metering backend, and the figure is
  NULL-loud when unattributable (no hardcoded price table for any provider). The
  **only run gate is budget** — per-task / per-day / per-project / per-org dollar
  ceilings, enforced by the walker; `QuotaPolicy` is deleted. See
  `docs/operator-guide/costs.md`.
- **Quality bars** — `LISTEN/NOTIFY` (no 1s polling), conformance suites for
  Allocator / JobQueue / EventStore / SecretStore / CostResolver / Repositories,
  ~13 Stryker mutation clusters + a weekly full-repo job (`mutation-weekly.yml`),
  oxlint warnings driven to ~5 with ~25 rules flipped warn→error, and a hardened
  15-step strictness gate.

### What is still ahead

The forward plan — the single live tracker — is **`ROADMAP.md`**: current state,
the frozen phase history (Phases 0–3 + autonomy Phases 1–2 + SaaS hardening), the
durable architecture posture, and the live to-do.

The **autonomy engine** (autonomy Phases 1 and 2) is **built and merged**. Tanren
drives its own spec graph via the autonomous **DagWalker**, with persisted
**priority**, **real-LLM Forge** (deterministic answerers → `tests/fixtures/`),
**webhook-first issue intake**, a **stub-ban lint** (`no-production-stubs`), a
**real-resource `just e2e` gate** (`QuotaPolicy` deleted — budget is the only run
gate), DAG-aware **intent-preserving conflict resolution**, the **native
intelligent merge queue** (DAG-order serialized merge + batch-check + bisect),
**CI-intelligence parity** (flaky-quarantine · CI analytics · queue stats), and
**Mergify removed entirely**. The durable design rationale is
**`docs/architecture/autonomy-engine.md`**.

**The tanren-owns-the-engine cutover is COMPLETE — it is the single live path.**
The GitHub-shaped `VcsProvider` is decomposed by purpose into four seams — a **jj
(jujutsu) `WorkspaceVcsCore`** (jj-only, no git fallback;
`engine/providers/jjWorkspaceVcsCore.ts`), a minimal **`CodeHost`**
(push/fetch/land-to-`main`; `githubCodeHost.ts`), the guaranteed fail-closed
**`MergeAuthority`** (the sole merge decision; `engine/merge/mergeAuthorityImpl.ts`),
and best-effort **`VisibilityProjection`** (the PR/check mirror). The unified
**`integration_nodes`** run model replaces the speculative-vs-real divergence; a
**never-discard `BaseShiftCoordinator`** rebases dependent work in place (the old
percolation _superseded + regenerated_ — discarding work; that is gone); and the
auditor emits **P0–P3 findings** gated by an **`auditPosture`** DORA knob. The
cutover is **no longer flag-gated**: the WS-A/WS-B series deleted the kill-switch
env vars (`MERGE_AUTHORITY_LIVE`, `CONFLICT_RESOLVER_JJ_LIVE`, `BASE_SHIFT_LIVE`,
`INTEGRATION_NODES_DRIVE`, `WALKER_JJ_LOCAL_BASE`) — jj as the conflict resolver,
live base-shift, and jj-local integration are unconditional. A dependent run
jj-assembles its base from the **real ancestor PR-head refs** (`runs.ancestor_stack`
— true stacked PRs); there is **no synthesized `tanren/integ` host ref**, and the
legacy `speculative_base` + `integrated_ancestor_shas` columns are dropped. The
`integration.*` metrics read-side (`rebase_vs_rebuild`) is **built** (route +
compute + insights). apex remains the live-validation vehicle — a whole-product loop
merging through the live jj/`MergeAuthority` path is the open item — but the engine is
the single path regardless. Full rationale:
**`docs/architecture/tanren-owns-the-engine.md`**.

**The only remaining major effort is Phase 3 — `apex`**: a max-difficulty fixture
that takes a one-paragraph brief to a deployed product (URL shortener + Slack bot +
web UI) **autonomously**, over real surfaces. It is the **active live-validation
vehicle** — the operator role + run rhythm is `docs/operator-guide/apex.md`, the
**concrete drive-from-zero playbook** is `docs/operator-guide/apex-run-playbook.md`,
and the **templating doctrine** (every project DAG seeds from a validated template;
no from-scratch-into-a-project) is `docs/roadmap/templating-system.md`. The Tier-1
credentials (GitHub App + Slack + a deploy target — see
`docs/operator-guide/validation-credentials.md`) are provisioned, and it spends real
credits under the $50 budget ceiling (BYOK Codex runs at $0).

**Honest proof state.** Successive apex trials — v37–v46 ran on the previous WSL
host through 2026-06-19; v47–v79 have run on the new NixOS host from 2026-06-23
through 2026-07-04, roughly a trial a day since 2026-06-28 — each flushed real
engine bugs now fixed on `main`. **No live run has yet closed the full autonomous
loop** (issue → triage → fix → merge → deploy → a working product) — that is
precisely what apex still has to prove. The v49-era infra halts (task #21
runner-INSERT PK race + derive synchronous-wait breaker) are resolved (#21A
shipped as PR #705; #21B obviated by PR-F #693). The current frontier as of v79
sits inside the product-build loop itself: writer subtask sizing (PR #731), plan
stall recovery (PR #726), template composition semantics (fragment-based
composer PR-A #688 → PR-G #699), PR-enqueue timing (PR #724 + the #725 atomic
3-write seam + orphaned-PR startup sweep), and issue-triage routing. The v79 fix
(PR #734) enables triage → new-spec insertion on real out-of-scope findings —
the closest we've been to the issue-loop half of the apex proof firing
autonomously, without yet closing the loop end-to-end. Trial-driven fixes
landed 2026-06-30 → 2026-07-04 also include PRs #715/#719/#720/#721/#723/#728/
#729/#730/#732/#733 across writer/planner/composer/watchdog/observability, plus
the audit rounds #708–#718 (writer-seam doctrine sweep, designOracle mode-aware
re-drive, priorEvents discipline, writer-seam tail cleanup).

Smaller near-term items: the **benchmark seed corpus**, `typify→serde` codegen, and
the first whole-repo mutation baseline; long-horizon: a second `CodeHost` backend
(GitLab) and the Rust rewrite / native harness. (The forge audits/inbox DAL clusters
are now migrated onto the `Repositories` seam — that item is done.)
(Vault per-run scoped credentials — the last big data-plane de-privilege — is now
**done**.) None of these block the core promise above.

## Quickstart for a real run (operator flow)

```sh
direnv allow                      # nix-direnv enters the devshell (toolchain pinned via flake.nix)
just secrets-migrate              # one-time: move .env / .env.validation.local / connections.manifest.local.yaml to the canonical secrets dir (see docs/operator-guide/validation-credentials.md)
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

> **Fresh DB.** The collapsed baseline holds `org_id` NOT NULL on the core
> tables; a volume created against an older schema can't be backfilled in place.
> Start clean with `just down-dev` (removes volumes) then `just up-dev`. Volume
> wipes are expected — Tanren has no legacy-data compatibility surface.

## Local Smoke

```sh
corepack enable
pnpm install
just fast-check                   # the 15-step non-build gate (format/lint/types/arch/drift/knip/spell/test)
just smoke
```

`just smoke` builds the orchestrator, worker, allocator, dashboard, and runner
images, starts the stack, and verifies:

- `smoke-connectivity` — `tanren doctor` (orchestrator / Postgres / Vault) +
  direct runner SSH reachability.
- `smoke-ssh-integration` — the real SSH substrate.
- the real run path across the API↔worker process boundary
  (`smoke-plane-split-*`, including the P3b/P3c `42501` de-privilege proofs).
- the RLS isolation proofs (`smoke-rls-*`, including `smoke-rls-allocator`).

There is no synthetic `hello` workflow — it was purged from the runtime; the
smokes above exercise the real boundaries. The opt-in component live proofs
(`just live-codex-*`, `live-github-draft-pr`) drive real Codex / GitHub against an
owned fixture repo with real credentials; the full real-resource gate is `just
e2e` (see `docs/operator-guide/e2e.md`).

To tear down: `just compose-down` (alias for `just down-dev`, which removes
volumes).

## Roadmap & source of truth

- **`ROADMAP.md`** — the single consolidated roadmap: current state, the frozen
  phase history (Phases 0–3 + autonomy Phases 1–2 + SaaS hardening), the durable
  architecture posture, and the live forward to-do (apex · benchmark seed corpus ·
  remaining DAL · mutation baseline · residual hardening).
- **`PROJECT_BRIEF.md`** — the durable vision and architectural invariants (the
  source of truth for _what Tanren is_).
- **`docs/architecture/`** — the durable design rationale: the autonomy engine
  (`autonomy-engine.md`), the harness protocol, future refactor/scale, and the
  other shipped seams.
- **`docs/operator-guide/`** — operator runbooks (run, credentials, CLI, the
  native gate definition `ci-config.md`, deploy + demo, acceptance, costs, apex,
  auth, …).
- **`CLAUDE.md`** / **`AGENTS.md`** — orientation for agents working in the repo.
