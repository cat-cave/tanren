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
live-validated across easy / medium / hard tiers (the hard one a private repo),
each reaching a merged PR with real Codex and real credentials. The autonomy
engine (Phases 1 and 2) is merged: the DAG drives itself and the native
intelligent merge queue coordinates merges. The delivery path runs unconditionally
on the jj / `MergeAuthority` / `integration_nodes` engine (§1, the completed
cutover). Two doctrine programs have since landed in full: the **timeout/retry-cap
eradication** (the engine is now progress / sign-of-life based, no wall-clock kills
anywhere, CI-gated) and the **native design subsystem** (Tanren owns design the way
it owns the engine). The only remaining major effort is **Phase 3 — `apex`** (§4),
the live-validation vehicle that takes rough operator notes to a deployed product
autonomously.

**Honest proof state — what apex has and has NOT proven.** Each apex trial drives
Tanren harder and flushes real engine bugs now fixed on `main` (the run rhythm:
drive → halt on a real bug → fix-on-`main` → drain the backlog → rebuild → fresh
`v(N+1)`). Successive apex trials — v37–v46 ran on the previous WSL host through
2026-06-19; v47–v79 have run on the new NixOS host from 2026-06-23 through
2026-07-04, roughly a trial a day since 2026-06-28. **No run has yet closed the
product loop** (issue → triage → fix → merge → deploy → a working product, no
human in the inner loop). That is exactly what apex still has to prove; do not
describe it as done. The v49-era infra halts (task #21 runner-INSERT PK race +
derive synchronous-wait breaker) are resolved (#21A shipped as PR #705; #21B
obviated by PR-F #693). The v79-era product-build-loop frontier (writer subtask
sizing PR #731, plan stall recovery PR #726, fragment-based composer PR-A #688 →
PR-G #699, PR-enqueue timing PR #724 + the #725 atomic 3-write seam +
orphaned-PR startup sweep, triage → new-spec insertion PR #734 on real
out-of-scope findings) was HARDENED across three audit passes + cleanup wave —
**34 PRs (#738–#768) landed 2026-07-05 → 2026-07-07** closed every Codex-critic
(#1–#18) / Codex-round-3 (#1–#4) / RA1 / RA2 finding across Waves D1..D4 +
E-fix + F: the design-oracle finalize guard, `gateRework` required in
`BaseShiftCoordinatorDeps`, `MalformedAncestorStackError` typed classification,
the v79 loop-closure end-to-end fix (auditor prompt no-omit + `routeOne`
scope-first + `ensureFindingCoverage` empty-workItems + PARTIAL-coverage P0
synthesis + `acceptProposals` newSpecs materialization + `specs` provenance
columns via migration 0025), `demo.failed` + `usage.accounting_failed` event
schemas + `DEFAULT_ROUTE_EVENTS` seeding + severity promotions, the
design-oracle silent-fallback trio (typed errors + `design_contracts.mode`
column via migration 0026 threaded through all readers), a unified
`subscribeWithReconnect` helper across 4 subscribers, the walker `orderKey`
on stable `(created_at, spec_id)`, budget fails-closed on null-org, the
`notifySubscriber` reconnect wake latch, triage newSpecs dedupe via
migration 0027, the timeout-eradication lint extended (PR #750) to catch
bare `_pages`/`_rounds`/`_turns`/`_cycles`/`_passes`/`_reworks` stems +
SCREAMING_CASE loop-cap patterns, and the PR-F #693 doctrine debris sweep.
Audit rounds 2/3 (PRs #708–#718) landed the writer-seam doctrine sweep,
designOracle mode-aware re-drive, runFinalize prober filter, priorEvents
discipline. **A subsequent Wave H + F2 hardening push landed 2026-07-07 —
26 more PRs (#774–#799)** preemptively closed the F2 authoring path (what
was the honest v80 frontier at the start of that window):

- **Wave H #774–#787 (14 PRs)** — canonical fixed-point signature + ATOMIC
  `createValidated` persistence seam (audit finding H2 — task #150; one
  INSERT with `status='validated'`, no draft→flip window that the unified
  loader would silently ignore); guaranteed JIT env build reaches
  off-baseline toolchains (#776); design contract unified on project-scope
  — mode-keying dropped (#775); orgId invariant enforced at hydration
  (silent-degrade branches dropped, #778); allocators reclassified
  provisioning vs fixed-pool vs delegated + provider resource id persisted
  (#782/#786/#787); demo non-web arms + adapter-aware surface dispatch
  (#780); triage select + expose provenance columns downstream (#785);
  durable manual_external deploy attestation + real operator confirmation
  (#783); human-review mode uses durable parked state (#784);
  notifications no silent stubs + durable no-route record (#781); reject
  unknown deploy tokens + derive `testRunner` per runtime (#779).
- **F2 Round I #788–#791** — per-attempt `fragment.authoring.attempt`
  events (writer trajectory visibility, #788); prompt hardening with
  inline exemplars + slot-kind guidance + prior-org fragments + product
  context (#790); runtime-validity smoke (pnpm/bundle live invokers
  materialize the composed VFS into a temp dir + run the runtime's dep
  resolver, #789) — WIRED IN PROD by #791 (Codex HIGH found #789 was
  dead code without it, a `next@^99.0.0` fragment would persist as
  validated).
- **F2 Round II #792–#795** — parser hardened to a balanced-brace
  `apply()` body walker + non-vfs statement rejection
  (`fragmentBodyWalker.ts`; the prior lazy regex truncated at the
  first `}` inside a template literal); exemplars use inline literals
  so the parser doesn't reject identifier args (#793); PER-FRAGMENT
  ITERATION CEILING `FRAGMENT_AUTHORING_ITERATION_CEILING = 24`
  (arch-allow: timeout-class — integer count, NOT wall-clock, doctrine-
  compliant safety net over the 8-entry signature window for the
  pathological writer that produces a fresh rejection class every
  attempt) + sanitized signature (strips clock/id noise before hashing
  so a stuck LLM provider's cosmetically-different error every attempt
  no longer counts as progress) + batch compose post-authoring gate +
  persist-throw event (#794); real dep resolvers for python/go/rust
  (`uv pip compile` / `go mod download` / `cargo fetch`) + extended
  implicit-dependsOn tokens with justfile comment-strip (task #103,
  #795).
- **F2 Round III #796–#799** — parseStringLiteral single-pass unescape +
  splitArgs single-quote tracking (#796); sanitizer regex anchors +
  explicit `org_id` filter defense (#797); RETRACT-WITH-DELETE — the
  post-authoring batch compose rejection now DELETES the persisted row
  via `FragmentsStore.deleteById` so the org's `fragments` table stays
  free of cross-run contamination (Round-III H1),
  `fragment.authoring.succeeded` DEFERRED until the batch gate passes
  (H4 — no more succeeded-then-failed for the same id), failed emit
  carries the REAL per-fragment attempts count (H7 — not hardcoded 1),
  `skipped` batch arm EXPLICITLY handled as failure (M6 — no silent
  commit), empty `apply()` body rejected (M4 — the no-op stealth-
  downgrade class where a fragment persisted as validated but
  contributed nothing) (#798); pip/go/cargo live invokers wired in prod
  (#799 — same class as #791).

Two smaller documented gaps: scaffold specs (`specialize_seed` mode) see
no design context after migration 0026 (intentional — scaffolds
specialize toolchain, not product identity — but the design-oracle
silent-skip surface is widened vs pre-#756 behavior); and
`loadSpecWithProject` doesn't SELECT the new provenance columns, so a
future feature that needs them at read-time will require the schema+join
update. The autonomous-loop machinery AND the F2 authoring pipeline are
complete and hardened by regression pins. **The honest open frontier for
v80 is closing the full autonomous loop end-to-end** — the F2 pre-
hardening means the run should reach further into the greenfield
product-build loop than any prior trial before surfacing the next real
bug. The drive playbook is `docs/operator-guide/apex-run-playbook.md`;
the operator role and run rhythm live in `docs/operator-guide/apex.md`;
the templating doctrine is `docs/roadmap/templating-system.md`.

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

### tanren-owns-the-engine cutover (COMPLETE — the single live path)

The merge/integration subsystem has been cut over from the GitHub-shaped
`VcsProvider` + speculative-integration + change-percolation model to the
**tanren-owns-the-engine** model (`docs/architecture/tanren-owns-the-engine.md`).
**The cutover is the single live path on `main` — no longer flag-gated** (the
WS-A/WS-B series deleted the kill-switch env vars). apex remains the
live-validation vehicle: a whole-product loop merging through the live
jj/`MergeAuthority` path is the open item, but the engine is the single path
regardless:

- **Four purpose-decomposed seams** (Wave 1): a jj (jujutsu) `WorkspaceVcsCore`
  (jj-only, **no git fallback**), a minimal `CodeHost` (push/fetch/land-to-`main`),
  the guaranteed fail-closed `MergeAuthority` (the sole merge decision), and a
  best-effort `VisibilityProjection` (the PR/check/comment mirror) — under
  `engine/contracts/` + `engine/providers/` + `engine/merge/`, each with a
  conformance suite written first (Wave 0).
- **Unified run model** (Wave 2): `integration_nodes` (one run object — eager
  dependent, merge batch, and stacked PR are the same thing), `MergeAuthority` as
  the sole merge decision, the **never-discard** `BaseShiftCoordinator` (jj-rebase
  in place — the old percolation supersede+regenerate, and the strand reconciler it
  spawned, **deleted**, net −906 src LOC), and audit-as-P0–P3-findings gated by an
  `auditPosture` DORA knob.
- **Live cutover** (Wave 3): jj as the live conflict resolver, live base-shift
  execution, and `integration_nodes` proof-reuse + jj-local integration. The
  follow-on WS-A/WS-B series then completed the walker/percolation → jj-local
  cutover (the dependent run jj-assembles its base from the **real ancestor PR-head
  refs** in `runs.ancestor_stack` — no synthesized `tanren/integ` host ref),
  **deleted the kill-switch flags** (`MERGE_AUTHORITY_LIVE`,
  `CONFLICT_RESOLVER_JJ_LIVE`, `BASE_SHIFT_LIVE`, `INTEGRATION_NODES_DRIVE`,
  `WALKER_JJ_LOCAL_BASE` — each path unconditional), dropped the legacy
  `runs.speculative_base` + `integrated_ancestor_shas` columns, and **built the
  `integration.*` metrics read-side** (`rebase_vs_rebuild` route + compute +
  insights).
- **Pre-apex hardening** (merged): the SSH-token-as-env leak closed (the runner
  gets no secret value via Docker env), intake connectors fail loud on auth/HTTP
  failure, deploy no-op → loud when a deploy is expected, and the null-org
  BYPASSRLS fallback removed (fail-closed).

The walker/percolation → jj-local cutover and the `integration.*` metrics read-side
are **done**, and so is the §7 `VcsProvider` decomposition — the 26-method
God-interface is **fully DELETED** (a `grep VcsProvider services/*/src` finds only
doc-comments), split into the minimal `CodeHost` + best-effort `VisibilityProjection`
across a 9-PR series. The one residual (§4) is **not** dead code:
`resolveSpeculativeState` / the stacked-PR retarget in the merge dispatcher, which is
the live jj-local `ancestor_stack` base + retarget walk (a possible rename off the
"speculative" name is its only open item).

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

  > **Superseded by the cutover.** The `VcsProvider` seam, the
  > speculative-integration mechanism, and the change-percolation
  > supersede+regenerate path delivered here are **superseded** by the
  > tanren-owns-the-engine cutover (§1): the seam is decomposed into
  > jj `WorkspaceVcsCore` / `CodeHost` / `MergeAuthority` / `VisibilityProjection`,
  > and percolation's discard-and-regenerate is replaced by the never-discard
  > `BaseShiftCoordinator`. The intent-preserving conflict resolution + native
  > queue survive; only the discard-bearing parts were replaced.

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
the autonomy engine — the integration-node + never-discard rebase design, the
stub-ban + real-e2e guardrails, the intent-preserving conflict resolution, the
apex intent, and the usage-based billing principle — lives in
`docs/architecture/autonomy-engine.md` (the doc the in-code `§`-anchored comments
cite); the merge-engine cutover rationale is
`docs/architecture/tanren-owns-the-engine.md`. The 10 → 1M north-star is
`docs/architecture/future-refactor-and-scale.md`.

- **Clean adapter seams behind contracts + conformance suites.** Allocators,
  inbox source connectors, agent-harness adapters, notification channels, identity
  providers, secret stores, cost resolvers, the `Repositories` DAL, and the merge
  engine's purpose-decomposed seams are each a contract with a conformance suite.
  Adding a backend is a new impl + a registry entry, never a refactor. The full
  Track-A expansion is shipped: every adapter family above has real implementations
  (e.g. all nine notification channels, the eight-strong allocator family,
  Vault/GCP-SM/AWS-SM/1Password secret stores, github_oauth/OIDC/Authentik/local_dev
  identity).
- **The merge engine is decomposed by purpose (cutover, §1).** The original
  GitHub-shaped `VcsProvider` seam is superseded by four contracts: a jj
  `WorkspaceVcsCore` (`engine/contracts/workspaceVcsCore.ts` +
  `engine/providers/jjWorkspaceVcsCore.ts`), a minimal `CodeHost`
  (`codeHost.ts` + `githubCodeHost.ts`), the guaranteed `MergeAuthority`
  (`mergeAuthority.ts` + `engine/merge/mergeAuthorityImpl.ts`), and best-effort
  `VisibilityProjection` (`visibilityProjection.ts` + `githubVisibilityProjection.ts`)
  — each with a conformance suite. Delivery is native — the merge queue +
  `MergeAuthority` are Tanren's own and the gate runs over SSH publishing a
  `tanren/gate` check (no Mergify, no Actions) — so the residual GitHub coupling is
  the thin `CodeHost` surface (push/fetch refs + land-to-`main`) plus the optional
  `VisibilityProjection` mirror. The legacy `VcsProvider` interface + impls are
  **DELETED** (the §7 decomposition landed across a 9-PR series; `mergeable_state`
  severed to `CodeHost.compareRefs` ancestry) — only doc-comments name it now. A
  second backend (GitLab/Gitea) is a new `CodeHost` impl, held until a real
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

- **Phase 3 — `apex` (close the full autonomous loop).** The max-difficulty
  live-e2e fixture: a single paragraph of rough operator notes → a deployed product
  (URL shortener + per-link analytics + a Slack bot + a web UI), built autonomously
  over real surfaces, every change a merged PR with full provenance. apex tests
  **Tanren**, not the fixture: the driver acts as a non-technical end user over the
  HTTP API only, files real issues into Tanren for every defect, and never hand-fixes
  the generated repo. **The honest state (§1):** successive apex trials — v37–v46
  ran on the previous WSL host through 2026-06-19; v47–v79 have run on the new
  NixOS host from 2026-06-23 through 2026-07-04 — each flushed real engine bugs now
  fixed on `main`; **no run has yet closed the product loop** (issue → triage → fix
  → merge → deploy → a working product, no human in the inner loop). The
  v79-era product-build-loop frontier was HARDENED across three audit passes +
  cleanup wave (34 PRs #738–#768) — then a Wave H + F2 hardening push
  (26 PRs #774–#799 landed 2026-07-07) preemptively closed the F2
  authoring path (the honest v80 frontier at the start of that window),
  detailed in §1. The autonomous-loop machinery AND the F2 authoring
  pipeline are complete and hardened by regression pins. The honest open
  frontier for v80 is **closing the full autonomous loop end-to-end** —
  the F2 pre-hardening means the run should reach further into the
  greenfield product-build loop than any prior trial before surfacing the
  next real bug. To drive the next run: the operator role + run rhythm +
  proof portfolio is `docs/operator-guide/apex.md`; the **concrete
  drive-from-zero playbook** is `docs/operator-guide/apex-run-playbook.md`;
  the **templating doctrine** (no from-scratch-into-a-project; do NOT
  pre-create a template — the fragment-based composer, PR-A #688 →
  PR-G #699, is the single seed path) is
  `docs/roadmap/templating-system.md`. It spends real credits under the
  $50 ceiling on already-provisioned Tier-1 creds (BYOK Codex runs at $0).
- **v49-era infra halts (task #21) — RESOLVED, historical.** The apex-v49
  runner-INSERT retry loop
  (`duplicate key value violates unique constraint "runners_pkey"`) between the
  run-executor and the job-reaper, compounded by derive's synchronous wait on
  the template-build child run having no inner-failure circuit breaker (8-hour
  curl hang), is closed: (a) runner-INSERT idempotency in
  `services/allocator/**` shipped as PR #705 (task #21A), and (b) the derive
  synchronous-wait surface was OBVIATED by PR-F #693, which collapsed templating
  to fragment-only composition + the in-process F2 authoring loop — the
  template-build child run + its
  `engine/templates/creation/childRunProgressProbe.ts` progress breaker were
  deleted; derive's replacement synchronous wait on `runFragmentAuthoring` is
  the F2 writer→validate fixed-point convergent loop, progress-based by
  construction (no wall-clock kill; loud `FragmentAuthoringFailedError` at the
  fixed point). The current apex frontier sits inside the product-build loop
  (§1) — writer subtask sizing, plan stall recovery, template composition
  semantics, PR-enqueue timing, and triage → new-spec routing — not at the v49
  infra layer. The doctrine of record (with #21B reframed as OBVIATED) lives in
  `docs/roadmap/timeout-eradication.md`.
- **tanren-owns-the-engine — cutover COMPLETE, §7 decomposition LANDED; one
  net-keep residual.** The cutover is the single live path (§1): the
  walker/percolation → jj-local cutover landed (the dependent run jj-assembles its
  base from the real ancestor PR-head refs — no synthesized `tanren/integ` ref),
  `PgSpeculativeIntegrator` is deleted, the kill-switch flags are removed (each path
  unconditional), the legacy `speculative_base` + `integrated_ancestor_shas` columns
  are dropped, and the `integration.*` metrics read-side (`rebase_vs_rebuild` —
  tokens / wall-clock) is built. The **§7 `VcsProvider` decomposition is now also
  done**: the 26-method GitHub-PR-shaped God-interface is **fully DELETED**
  (decomposed across a 9-PR series into the minimal `CodeHost` + best-effort
  `VisibilityProjection`; `mergeable_state` severed to `CodeHost.compareRefs`
  ancestry; the dead methods dropped; primitives lifted to `contracts/codeHostTypes.ts`
  / `providers/githubRepoRef.ts` / the typed-pg-row `engine/data/pgRows.ts` seam — a
  `grep VcsProvider services/*/src` finds only doc-comments). What still lives on
  disk is **not** dead code: `resolveSpeculativeState` / the stacked-PR retarget
  (`workflow/reviewMerge/speculativeStackRetarget.ts`) is the live jj-local
  `ancestor_stack` base + PR-base retarget walk
  (`walker-jj-local-integration-design.md` §3.2/§3.3) — a net-keep whose only open
  item is a possible rename off the "speculative" vocabulary. A whole-product loop
  merging through the live jj/`MergeAuthority` path is the open live-validation item.
  See `docs/architecture/tanren-owns-the-engine.md` §7–§8 +
  `docs/architecture/vcsprovider-codehost-decomposition.md`.
- **Benchmark seed corpus.** The tanren-method benchmark toolkit is code-complete
  (`engine/benchmark/**` — runner, scorecard, reducers, accept, store, stats;
  experiments routes; `tanren experiments`/`cells` CLI). What remains is the
  **content**: tiered seed repos + hidden content-addressed `accept` tiers + the
  experiments themselves, run across the corpus to pre-tune Tanren's default knobs.
  See `docs/roadmap/tanren-method-benchmark.md`.
- **DAL + neutral-schema tail.** The forge audits + inbox stores are now migrated
  onto the `Repositories` seam (`engine/repositories/{audits,inbox}.ts`); no forge
  store issues raw SQL. What remains is `typify → serde` codegen (share the neutral
  JSON-Schema with a future Rust impl) and the first whole-repo `mutation-full`
  baseline (the recipe + weekly job exist; capture the first full-repo number +
  add the dashboard/routes clusters).
- **Residual hardening.** The `schemaCore.ts` `.default('{}'::jsonb)` /
  `'{}'::text[]` column defaults (a latent-500 source) survive on this zero-users,
  single-baseline codebase. (The `resolveCredentials.ts` `orgId === ''` silent-BYOK
  branch is already FIXED — it is now an explicit `OrgScope` discriminated mode
  (`{ kind: "org" }` vs `{ kind: "unscopedPlatform" }`) that fails loud
  (`UnscopedOrgError`) on a missing tenant scope rather than degrading to BYOK.)
- **Timeout / retry-cap eradication — explicit family DONE + CI-gated; disguised
  survivors caught as found.** The whole multi-PR program shipped (#609–#622): the
  `ActivityWatchdog` (`engine/ssh/activityWatchdog.ts`) replaced every
  `DEFAULT_TIMEOUT_MS`-threaded kill-timeout; `retryUntilConverged`
  (`engine/workflow/retryUntilConverged.ts`, wrapping `convergenceDetector`) replaced
  every `MAX_*` / `maxPolls` give-up; the infra-hold ceilings were reframed off fixed
  counts onto sustained-non-recovery; and the enforcement lint
  `scripts/check-architecture-timeouts.mjs` is **CI-gating**. **However the
  eradication was not 100% at ship**: apex v44/v45 surfaced two _disguised_ survivors
  the initial lint missed — (a) the ssh2 `timeout:` socket idle-timeout, which kills
  a running command on any quiet gap (root cause of #638; the lint now flags this
  pattern), and (b) the `ActivityWatchdog` liveness probe reading newest-mtime, which
  a lock-file heartbeat defeated, allowing a stalled job to run forever (#640; fixed
  with a structural probe: file count + total bytes + a progress-based backstop).
  apex v49 surfaced the doctrine's next extension — task #21: derive's
  synchronous wait on the template-build child run had no inner-failure circuit
  breaker, so a downstream runner-INSERT retry loop presented as an 8-hour curl
  hang. #21A (runner-INSERT idempotency) shipped as PR #705; **#21B was OBVIATED
  by PR-F #693**, which collapsed templating to fragment-only composition + the
  in-process F2 authoring loop — the template-build child run + its
  `engine/templates/creation/childRunProgressProbe.ts` progress breaker were
  deleted, and derive's replacement synchronous wait (`runFragmentAuthoring`) is
  progress-based + fixed-point convergent by construction. PR #702 extended the
  enforcement lint to close the audit-#672 evasion paths (`cutoff/until/endsAt`
  families). The doctrine stands: every safety / hang-detection mechanism must
  be PROGRESS / SIGN-OF-LIFE based; disguised survivors are caught and fixed
  (or obviated) as found. The as-built inventory + doctrine of record is
  `docs/roadmap/timeout-eradication.md`.
- **Type-aware lint strictness ratchet — `no-unsafe-type-assertion` tail (~310
  casts).** The type-aware pass (`oxlint --type-aware`, config
  `oxlintrc.typeaware.json`, powered by oxlint-tsgolint/tsgo) is ratcheted
  rule-by-rule and the bulk of the wave is **done**: the **`correctness` category is
  ON at error** (all its rules triaged to zero and the surfaced bugs fixed — a
  `[object Object]`-stringification class on raw pg rows + Hono bodies, `never`-
  template guards, redundant unions — except `unbound-method`, held off as
  false-positive-only on function-valued object props), and the **tractable
  `suspicious` rules are individually at error** (`no-unnecessary-type-assertion`
  / `-conversion` / `-boolean-literal-compare` / `-template-expression` /
  `-type-arguments`, plus the exhaustive-`switch` `never`-default). The one large
  deferred rule is **`no-unsafe-type-assertion`** (the `suspicious` category stays
  OFF for it): the pg-row trust-at-boundary class is **done** via the `pgRows.ts`
  typed read seam (`queryRawRows` / `requireRow` / `oneOf` + `client.query<RawRow>()`
  - zod-enum decodes — the whole Repositories/store seam now validates rather than
    `as`-asserts), but **~310 non-pg-row casts remain**, sequenced as incremental
    per-class waves: orchestrator HTTP/Hono ~238 (`response.json()` decodes, `as never`
    event writes, jsonb-walk provider guards, the `orgScopingPool` proxy), dashboard
    ~57 (DOM/React + client serializers), allocator ~7, cli ~8 (`JSON.parse` /
    external input). `no-unnecessary-type-parameters` (4) is also held — its "fix"
    would push unsafe casts out to callers. The remaining categories
    (pedantic/style/restriction/nursery) stay OFF pending later rule-by-rule ratchets.
- **Entity-analysis layer — BUILT (was native follow-ons).** All of it landed:
  increment 1 (vendor `sem` + answerer wiring), §3.1 the checker risk-oracle from a
  host-side `sem` producer (`engine/oracle/semEntityProducer.ts`), §3.2 the
  entity-merge native first-pass in the base-shift conflict path (the pure
  splice + disjointness decision in
  `workflow/reviewMerge/conflictResolver/entityMergeFirstPass.ts`; the `sem` + jj
  runner-backed seams + hook in `.../semEntityMerge.ts`; wired at
  `dag/baseShiftLiveResolve.ts` — a library pre-pass, NOT a git merge driver), and
  §3.3 entity-anchored issue Claims (`entity_claims` /
  `engine/repositories/entityClaims.ts` + the self-validating oracle). See
  `docs/roadmap/entity-analysis-layer.md` for the as-built record.
- **§6 apex-e2e test gaps.** The hermetic apex e2e driver exists (§6); close the
  remaining gaps in its coverage of the post-merge / deploy / issue-loop stages as
  the next apex run exercises them.
- **Native design subsystem — BUILT + wired; one LIVE exercise remaining.** Tanren
  owns design natively: a domain-general, persisted, versioned `DesignContract`
  (`engine/design/`) authored by a native design agent + design phase, **injected
  into the writer on every generation**, verified by a domain-aware **design oracle**
  (`engine/workflow/designOracle/`) whose findings re-drive the writer in the **same
  DAG, no handoff seam**; design binds to first-class personas (strict resolution) +
  behaviors (exhaustive coverage) — the moat a standalone design tool structurally
  cannot have. WS-D1..D4 are merged and the verify→re-drive loop **closes end-to-end**
  (proven by a CI-gated eval harness, no live LLM). What remains: the subsystem has
  **NOT yet been exercised on a live run with a captured `DesignContract`** (the next
  apex run must capture a real design intent at intake — WS-D8), and true rendered-pixel
  visual fidelity is the WS-D4a live-render follow-on (today the oracle verifies
  behavior-coverage + static/source-readable fidelity). See
  `docs/roadmap/native-design-subsystem.md`.

---

## 5. Held / long-horizon (explicit triggers, not the calendar)

- **GitLab / VCS beyond the thin `CodeHost` surface.** The seam already shipped
  (§3 — the cutover decomposed it from `VcsProvider` into `CodeHost` +
  `VisibilityProjection`); the Mergify/Actions coupling that previously justified
  deferring this is gone. A second backend is a new `CodeHost` impl, built when a
  real second-backend requirement exists.
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

apex is the vehicle for proving the **greenfield** loop end-to-end (not yet closed —
§1, §4). The horizon past it is **Tanren building Tanren**: brownfield change
against this monorepo, the interactive/UX surface that
the API-only apex driver can't reach, and the self-update question apex never asks
(how a running Tanren adopts a merged change to its own code without bricking
itself). The bridge fixtures (brownfield-apex → UX e2e → self-change), the
two-loop self-update model, and the deployer-can't-brick-itself rule are designed
in **`docs/roadmap/dogfooding.md`**. How a team should _drive_ this repo with
parallel agents (the orchestration discipline behind every PR above) is
**`docs/playbooks/parallel-orchestration.md`**.
