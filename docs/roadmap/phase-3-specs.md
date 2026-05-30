# Phase 3 Specs

Detail entries for Phase 3 — **v0 completion above the Phase 2 operator-control baseline**.
Scope-bucket prose is in `phase-3.md`; this doc turns the buckets into specs with
`Owns` / `Consumes` / `Produces` and acceptance criteria, in the format of
`phase-2a-specs.md` / `phase-2b-specs.md`. Status: **merged.** Tier 1
(P3-0001…0009) and the bulk of Tier 2 (P3-0010…0030) are on `main`. The honest
remaining items are the P3-0009 live demo + cross-seam live validation (need real
credentials), the agy/pi/reasonix harnesses (await CLI specs; aider is done),
the deferred GitLab/VCS abstraction, and one open Forge write-action design item
(see [`../design/phase-3-hifi-gaps.md`](../design/phase-3-hifi-gaps.md)).

Phase 3 splits into two tiers:

- **Tier 1 — Foundational vertical slice (P3-0001…0009).** The minimum that makes
  **one real operator-driven run genuinely execute → go green → merge**, entirely
  from the dashboard, with no acceptance-script harness and no staging. This tier
  is the unit that makes Phase 2B's claimed capability _real_ (see "Reconciling
  Phase 2B" below). Build this first.
- **Tier 2 — Expansion (P3-0010…0030).** Product breadth beyond the core loop —
  thick Forge, DAG canvas, discovery, full onboarding, observability, provider
  and channel expansion, hardening. Not required to evaluate the core loop;
  several are gated on hi-fi prerequisites that must be locked first (see
  "Hi-fi prerequisites").

## Reconciling Phase 2B (why this doc exists) — RESOLVED

Phase 2B shipped the operator **dashboard surfaces** (shell, onboarding,
project/spec, run-detail, history/costs, failure-recovery, trigger). At the time
those surfaces sat on top of a workflow engine the dashboard could not yet drive.
Tier 1 closed that gap; the items below are recorded as the history of what was
fixed:

- **The run executor was missing.** `createQueuedRunFromSpec` enqueued a `plan`
  job (`job_queue`) that nothing in the running orchestrator service dequeued.
  **P3-0001 fixed this**: a background run worker
  (`services/orchestrator/src/engine/worker/`, `TANREN_RUN_WORKER=1`) now claims
  and executes `plan` jobs, so a dashboard-triggered run runs end-to-end. The
  direct-execution `scripts/acceptance/{easy,medium}.ts` harnesses were then
  **deleted** — the system is exercised only through the real dequeue→execute
  path.
- The 2B real-functionality-validation claims are therefore now exercisable:
  - P2B-0006: "operator completes a fixture-medium run fully through the
    dashboard … with persisted cost, PR, CI, and subtask state."
  - P2B-0008: "the resulting re-plan run **completes successfully**."
  - ROADMAP Phase 2 exit: "the dashboard runs end-to-end … run trigger, run
    detail … AND failure recovery on a forced-halt run."

    Their **final** validation is the P3-0009 live demo, which still needs real
    credentials to record (the one honest gap remaining).

- Credential→run resolution is wired (P3-0002: project/org credential refs +
  `resolveCredentialsForRun`), and repo connectivity is the GitHub App model
  (P3-0003: per-org installation tokens), with the static-token path retained
  only as a dev/back-compat fallback.

**Correction of record (now resolved):** the run executor was an implicit
Phase-3 prerequisite that no plan named. Tier 1 named it (P3-0001) and built the
connectivity/credential/gate/merge work around it. **Phase 2B's exit criteria are
met now that Tier 1 has landed**; the P2B-0007 demo (re-homed here as P3-0009) is
the recorded live proof, pending real credentials to execute.

## Tier 1 dependency graph (foundational slice)

```text
P3-0002 credential-resolution ─┐
P3-0003 github-app-connectivity ┤
                                ├─→ P3-0001 run-executor-worker ──┐
P3-0006 per-repo-bootstrap ─────┤                                 │
                                │                                 ├─→ P3-0009 phase2-live-demo-closeout
P3-0004 repo-sourced-ci-config ─┴─→ P3-0005 in-loop-gate-check ───┤      (closes Phase 2 for real)
P3-0007 checker-intent-only ────────────────────────────────────┤
                                     P3-0008 review-and-merge ────┘
```

Critical path: **P3-0002 + P3-0003 + P3-0006 → P3-0001** (an executor with
nothing to resolve/connect/bootstrap is inert) → **P3-0004/0005/0007** (green) →
**P3-0008** (merge) → **P3-0009** (demo). P3-0002/0003/0004/0006/0007 can be
built in parallel; P3-0001 integrates them; P3-0005 depends on P3-0004; P3-0008
and P3-0009 are serial at the end.

---

## Tier 1 — Foundational vertical slice

### P3-0001 — run-executor-worker

**Owns**: `services/orchestrator/src/engine/worker/**` (new), the worker wiring in `services/orchestrator/src/main.ts`, `services/orchestrator/tests/**worker**`.
**Consumes**: P2A-0006 (allocator), P2A-0011 (run/task state), P2A-0012 (planner loop `runPlannerLoopWorkflow`), P2A-0014 (events/SSE), P3-0002 (credential resolution), P3-0003 (github connectivity), P3-0006 (workspace bootstrap).
**Produces**: the **missing keystone** — a background worker in the orchestrator service that claims `queued` jobs and executes the plan→write→check→audit→draft-PR→CI workflow to completion, so a dashboard-triggered run actually runs (streams live via P2A-0014, halts land on the P2B-0008 recovery surface).

**What**: A worker loop that uses the existing atomic claim (`job_queue` already has `FOR UPDATE SKIP LOCKED` + status CAS to `running`) to claim `plan` jobs; loads run+spec+project; builds dependencies (SSH substrate, allocator via `buildAllocatorFromEnv`, `FetchGitHubHttpClient`, secret store); allocates a runner; resolves credentials via P3-0002; assembles `PlannerRunContext`; invokes `runPlannerLoopWorkflow`; then `complete`s or `fail`s the job. The workflow already persists run/task/cost state and emits events, so run-detail, history/costs, and the recovery surface light up with no extra wiring.
**Why**: Without this, every dashboard-triggered run (and every recovery re-plan) is queued and never executed — the single reason the 2B loop cannot be exercised. It is the prerequisite for P2B-0006/0007/0008 to be real.
**How**: In-process loop inside the orchestrator initially (it already owns pool/secrets/allocator), behind a `TANREN_RUN_WORKER=1` flag, structured for later extraction to a standalone worker service. Bounded concurrency (`TANREN_RUN_WORKER_CONCURRENCY`, default small). `SIGTERM` graceful drain (stop claiming, let in-flight runs finish or checkpoint). Timeout/crash → `job_queue.fail(id, {kind, message})` and a run outcome in the recoverable set so it surfaces on P2B-0008. Honor existing escape-hatch + attempt accounting; never double-execute a claimed job.

**Test plan**: a deterministic executor test with fake adapters proving claim → execute → state transitions (queued→running→done and →failed→recoverable); concurrency cap test; graceful-shutdown test; a gated local live smoke against fixture-easy. `corepack pnpm run check`.
**Quality bar**: claims are atomic and idempotent (no double-run); a crash mid-run leaves the run in a recoverable state, never silently lost; the worker is off unless the flag is set (so CI smoke and tests are unaffected); no new bespoke queue — reuse `job_queue`.
**Real-functionality validation**: an operator triggers a run from the dashboard, walks away, and the run progresses through plan→write→check→audit→draft-PR→CI on its own, observable live in run-detail, with cost/subtask/PR state persisted — no acceptance script, no manual step advancing.
**Worktree-isolation safety**: owns the new worker module + its main.ts wiring; does not change the workflow internals it calls.

### P3-0002 — run-credential-resolution

**Owns**: credential fields in `services/orchestrator/src/engine/config/projectConfig.ts`, a `resolveCredentialsForRun` resolver in the engine, org-default-credential storage + routes, the credentials-binding UI in `services/dashboard/src/components/project/SettingsBody.tsx` + a GitHub-token import path, `services/orchestrator/tests/**credentialResolution**`.
**Consumes**: P2A-0013 (credential CRUD + project config PATCH), P2A-0009 (redaction), P2B-0003 (settings surface).
**Produces**: the wiring that lets a run resolve **which** Codex + GitHub credentials to use, from project config or org defaults, instead of refs hardcoded by the acceptance harness.

**What**: Add optional `codexCredentialRef` + `githubCredentialRef` (a `credentials` sub-object) to the strict `ProjectConfigV1`; an org-level default credential per kind; and `resolveCredentialsForRun(override → project config → org default → typed error)` that P3-0001 calls before invoking the workflow. Add the **missing dashboard GitHub-credential import** (today only `opaque` + `codex_chatgpt_auth` import paths exist) and a "Credentials" binding section in the P2B-0003 settings surface with dropdowns sourced from `GET /orgs/:orgId/credentials` filtered by kind, persisting via the existing project-config PATCH.
**Why**: P3-0001 cannot execute without resolved credentials; today a UI-created project carries none and the workflow throws `codexCredentialRef is required`.
**How**: Schema additions are backward-compatible (optional fields, V1.x or guarded V2 migration via `migrateProjectConfig`). Resolver is a pure function over project config + an org-default lookup. UI reuses redaction (write-only secret inputs; refs/labels only on read).

**Test plan**: schema migration tests, resolver priority/error tests, credential-list-by-kind UI tests, settings-PATCH integration test, `corepack pnpm run check`.
**Quality bar**: secrets never rendered after entry; resolver returns a typed error (surfaced by P3-0001 onto the recovery surface) rather than throwing raw; org without a bound/default credential gets an actionable message, not a 500.
**Real-functionality validation**: an operator imports a Codex bundle + a GitHub credential in the UI, binds them on the project settings surface (or sets org defaults), and a subsequently triggered run resolves and uses them with no harness involvement.
**Worktree-isolation safety**: owns the config schema fields, resolver, org-default storage, and the settings credentials UI; does not own the executor.

### P3-0003 — github-app-connectivity

**Owns**: `services/orchestrator/src/engine/credentials/githubApp**` (new), `services/orchestrator/src/engine/providers/githubAppTokenMinter.ts` (new), `services/orchestrator/src/routes/auth/githubAppInstall.ts` (new), the token-resolver swap in `services/orchestrator/src/routes/brownfield/index.ts` + run github auth, the install onboarding step in `services/dashboard/src/routes/onboarding/**`, `docs/operator-guide/github-app.md`, `services/orchestrator/tests/**githubApp**`.
**Consumes**: P2A-0003 (OAuth pattern to mirror), P2A-0009/0013 (credential storage), P2A-0004 (Vault).
**Produces**: the **preferred long-term repo-connectivity model** — per-org GitHub App installation with auto-rotating installation tokens — replacing the static-PAT/shared-token stub for repo clone, draft PR, and CI status.

**What**: A new `github_app_installation` credential kind (App id + private-key PEM in Vault); JWT signing → installation-access-token minting with caching + refresh (≈10-min app JWT → ≈1h installation token; refresh on expiry/401); per-org `installation_id` persisted in the existing `organizations.config` JSONB; an install onboarding flow mirroring the OAuth state/callback pattern (`GET /auth/github-app/install?orgId=…` → GitHub App install → callback stores `installation_id`), surfaced as a dashboard onboarding step; and a token-resolver swap so brownfield link + runs prefer the org's installation token (static-token fallback retained for dev/back-compat) plus a 401-refresh in the GitHub HTTP client.
**Why**: PATs are brittle under rotation/expiration; the App model is the intended one (already assumed by brownfield + onboarding spec language) but was deferred ("only OAuth in v0"). Pulling it forward means the first real run uses production-shaped connectivity, never the throwaway PAT path.
**How**: Mirror `githubProvider.ts` + `routes/auth/index.ts` (state cookie, callback, persist-to-org). Token minter is a small JWT+exchange service with an in-memory cache keyed by installation. Org config gains a typed `github_app` block.

**Test plan**: JWT-mint + token-exchange unit tests (mocked GitHub), install-callback state-validation test, resolver-precedence test (App installation → static fallback), 401-refresh test, `corepack pnpm run check`.
**Quality bar**: App private key only in Vault, never logged/rendered; installation token cached with expiry and refreshed before use; static-token path still works so existing tests/dev are unbroken; the dashboard never sees the App private key.
**Real-functionality validation**: an operator installs the GitHub App on their org from the dashboard, links a repo, and a run clones + opens a draft PR + reads CI using an auto-minted installation token — no PAT anywhere.
**Worktree-isolation safety**: owns the App credential/minter/install-flow + the resolver swap; coordinates with P3-0002 on credential storage namespacing.

> **Ops dependency:** registering the GitHub App (org-admin action), installing it on the target org/repo, and providing the App id + private key to Vault/env are operator setup steps documented in `github-app.md`; they are not code.

### P3-0004 — repo-sourced-tiered-ci-config

**Owns**: the `tanren-ci.yml` schema + parser/validator in `services/orchestrator/src/engine/ci/**` (new), `services/orchestrator/tests/**ciConfig**`.
**Consumes**: P2A-0011 (run state), P3-0003 (repo read).
**Produces**: a repo-sourced tiered CI config (config-bucketing: the CI artifact lives in the **target repo**), with named tiers (`fast` = lint/typecheck/unit; `slow` = integration/e2e/build/mutation/perf) and a `when` policy (`per_iteration` / `pre_audit` / `pre_merge`) — one source of truth that both GitHub Actions and the in-loop gate (P3-0005) invoke.

**What**: Define and parse `.github/workflows/tanren-ci.yml` (or `.tanren/ci.yml`) into typed tiers + commands + when-policy; expose a resolver the in-loop gate and the CI-poll both read. Validate shape; degrade gracefully when absent (documented default tiers).
**Why**: Deterministic gate-checks ([[verification-architecture-split]]) need a single declarative source; without it, in-loop gating and GitHub CI drift.
**How**: Zod schema + reader that runs against the cloned workspace (or via repo read pre-clone). No execution here — just the contract P3-0005 consumes.

**Test plan**: schema/parse/validate tests, missing-file default test, `corepack pnpm run check`.
**Quality bar**: one schema, two consumers (Actions + in-loop gate); invalid config fails loudly with a typed error, never silently skips gating.
**Real-functionality validation**: a `tanren-ci.yml` committed to a fixture repo is parsed into tiers that the in-loop gate (P3-0005) executes and that a GitHub Actions workflow can mirror.
**Worktree-isolation safety**: owns the CI-config contract; does not execute gates (P3-0005).

> **Ops dependency:** a `tanren-ci.yml` must be committed to each target repo's default branch (placed by the operator or by the brownfield config-injection PR, P3-0016).

### P3-0005 — in-loop-gate-check-stage

**Owns**: a new `gate` task kind + `gate.*` events, the gate execution stage in `services/orchestrator/src/engine/workflow/**`, `services/orchestrator/tests/**gate**`.
**Consumes**: P3-0004 (tiered config), P3-0006 (bootstrapped workspace), P2A-0011 (task/event state), the SSH substrate.
**Produces**: exit-code-driven **deterministic gate-checks** on the runner workspace — fast tier per writer iteration, slow tier before audit — the automation half of the verification split (no agent).

**What**: Add a `gate` task kind that runs the resolved tier commands over SSH on the workspace, emits `gate.*` events with pass/fail + captured output, and routes the writer loop on failure (fast tier blocks the iteration; slow tier blocks the audit). Produces a failure report consumable by the optional root-cause helper.
**Why**: The live `acceptance-medium` evidence showed the checker Answerer cannot run tests (workspace never `install`ed) and never converges; deterministic gating is the fix and the prerequisite for a run reaching green.
**How**: Reuse the SSH substrate + run-state/event plumbing; exit-code-driven; no Answerer in the loop.

**Test plan**: gate pass/fail routing tests, event-emission tests, fast-vs-slow tier scheduling tests, `corepack pnpm run check`.
**Quality bar**: gate outcomes are deterministic + exit-code-driven; no agent judges test results; failures are observable (events) and actionable (report).
**Real-functionality validation**: a fixture-medium run runs the fast tier each writer iteration and the slow tier before audit, blocking on real failures and proceeding on real passes.
**Worktree-isolation safety**: owns the gate task kind + stage; consumes P3-0004's config and P3-0006's bootstrapped workspace.

### P3-0006 — per-repo-workspace-bootstrap

**Owns**: a post-clone bootstrap step in `services/orchestrator/src/engine/workspace/**`, `services/orchestrator/tests/**bootstrap**`.
**Consumes**: P2A workspace/git contract, the SSH substrate.
**Produces**: running the project's install/setup command after clone, so the workspace can actually build + test (the precondition for P3-0005 and for the checker reframe P3-0007).

**What**: After clone, run a per-repo bootstrap command (from `tanren-ci.yml` or project config; e.g. `pnpm install`) on the runner workspace; surface failures as a typed bootstrap error.
**Why**: The checker's `vitest: not found` failure traced to a workspace cloned-but-never-installed; gating + intent-checking both depend on a bootstrapped tree.
**How**: SSH command step keyed off the repo's declared install command; cached where safe.

**Test plan**: bootstrap success/failure tests, missing-command default test, `corepack pnpm run check`.
**Quality bar**: bootstrap failure halts the run with an actionable reason; never proceeds to gate/audit on an un-built tree.
**Real-functionality validation**: a fixture-medium clone is `install`ed before the first gate, so `fast`-tier unit tests actually run.
**Worktree-isolation safety**: owns the bootstrap step; does not own gating.

### P3-0007 — checker-intent-only-reframe

**Owns**: the checker Answerer prompt + schema constraint in `services/orchestrator/src/engine/answerers/**` (checker), `services/orchestrator/tests/**checker**`.
**Consumes**: P3-0005 (deterministic gates now own correctness), P2A answerer plumbing.
**Produces**: the checker reframed to **intent satisfaction only** — it no longer attempts to run tests/build (the deterministic gate does that), eliminating the flip-flop non-convergence seen in live runs.

**What**: Rewrite the checker prompt to forbid running tests/build and to judge only whether the change satisfies the spec's intent + acceptance criteria; constrain its output schema accordingly.
**Why**: Conflating reasoning checks with deterministic checks was the root cause of non-convergence ([[verification-architecture-split]]).
**How**: Prompt + schema change only; the deterministic gate (P3-0005) now carries correctness.

**Test plan**: checker prompt/schema drift tests, an intent-only judgment test, `corepack pnpm run check`.
**Quality bar**: the checker never asserts test results; clean separation from the gate.
**Real-functionality validation**: on a bootstrapped + gated run, the checker converges on an intent judgment instead of flip-flopping on un-runnable tests.
**Worktree-isolation safety**: owns the checker prompt/schema; relies on P3-0005 for correctness.

### P3-0008 — review-and-merge-automation

**Owns**: review-polling + merge-contract stages in `services/orchestrator/src/engine/workflow/**`, per-repo merge-integration config, `services/dashboard/src/routes/runs/review/**` wiring, `services/orchestrator/tests/**reviewMerge**`.
**Consumes**: P3-0003 (App connectivity), P2B-0004 (review-handoff sub-surface), P2A-0011/0014.
**Produces**: the **completion half** of the loop — real ready-for-review marking + changes-requested handling, and a merge contract with per-repo configurable integrations (Mergify queue · direct GitHub merge · external-reviewer handoff), plus conflict-resolver scaffolding.

**What**: Poll PR review state; mark ready-for-review; handle changes-requested back into the writer loop; merge via the per-repo-configured integration; scaffold conflict resolution. Wire the P2B-0004 review sub-surface to drive the operator hand-off.
**Why**: A v0 "merged-ready PR" is the actual product outcome (PROJECT_BRIEF §2.1); Phase 2 deferred review/merge. This closes it.
**How**: GitHub API polling via the App token; new `review`/`merge` task kinds + events; per-repo integration config (Mergify vs direct vs handoff).

**Test plan**: review-poll + changes-requested routing tests, per-integration merge-contract tests (mocked GitHub/Mergify), conflict-scaffold test, `corepack pnpm run check`.
**Quality bar**: merge never bypasses the configured integration or required checks; changes-requested reliably re-enters the writer loop; every action emits typed lineage.
**Real-functionality validation**: a green run's PR is marked ready, a requested change loops back and is addressed, and the PR merges via the repo's configured integration — observed from the dashboard.
**Worktree-isolation safety**: owns review/merge stages + config + the review-surface wiring; the heaviest Tier-1 spec (XL).

### P3-0009 — phase2-live-demo-closeout

**Owns**: the live demo execution + `ROADMAP.md` Phase 2 closeout evidence; supersedes the validation of P2B-0007.
**Consumes**: P3-0001…0008.
**Produces**: the recorded, **non-staged** Phase 2 proof — a fresh operator going blank-stack → GitHub-App sign-in/install → onboarding → credential bind → spec → autonomous run (plan→write→check→audit→gate→draft-PR→CI green) → review → **merged-ready PR**, plus a recovered forced-halt run — all through the dashboard, no CLI/harness.

**What**: Execute the canonical demo on the real Tier-1 loop against fixture-medium (and the forced-halt recovery path), capture run IDs + PR URL + recovery lineage, commit as Phase 2 completion evidence — the new baseline for the Tier-2 expansion work.
**Why**: This is the honest replacement for P2B-0007's claim; it can only run once Tier 1 exists.
**How**: Operator-driven; recorded; evidence committed under ROADMAP Phase 2.
**Test plan**: live demo execution + recording; the Tier-1 gated suites are green.
**Quality bar**: no step falls back to the CLI or DB; a failure rolls Tier 1 back into rework.
**Real-functionality validation**: the committed run IDs + merged-PR URL are independently inspectable and reproduce.
**Worktree-isolation safety**: docs/evidence after the live run.

---

## Tier 2 — Expansion (merged)

These turned the remaining `phase-3.md` buckets into specs. **The bulk are now
built and merged on `main`** (provider expansion incl. aider, notification
channels — all 9, allocator expansion, DAG canvas, discovery, full
greenfield/brownfield onboarding, `tanren-config` audit-gate, scheduled audits,
issue/inbox ingestion, governance, DORA, observability, deployment hardening).
The honest exceptions are agy/pi/reasonix harnesses (await CLI specs) and live
cloud/SaaS validation (needs real credentials). The thick-product surfaces are
built; their one open _design_ item (Forge in-conversation write-action approval)
is tracked in [`../design/phase-3-hifi-gaps.md`](../design/phase-3-hifi-gaps.md).

- **P3-0010 thick-forge-llm-backend** — LLM-backed Forge conversation reading `forge_turns` (P2A-0019), replacing templated v0 narration; pure swap, no schema change. _Depends:_ hi-fi thick-Forge interaction model.
- **P3-0011 demo-role-llm-wiring** — replace templated demo narration with a real Answerer call (schema P2A-0008 ships). _Depends:_ P3-0012 or existing Codex.
- **P3-0012 provider-expansion** — Claude Writer/Answerer, opencode Writer (Zai GLM 5.1 only; no Wafer). Slots into P2A-0006 fallback-chain, no migration. _Ops:_ provider API keys.
- **P3-0013 spec-dag-canvas** — full SVG DAG + DAG-primary project view over P2A-0018 entities/edges. _Depends:_ hi-fi DAG-primary view.
- **P3-0014 spec-discovery-flow** — Forge classifies an insight → proposes specs with DAG placement + provenance (feature/bug/strategic). _Depends:_ P3-0010 + P3-0013 + hi-fi spec-discovery.
- **P3-0015 greenfield-onboarding-full** — multi-round Forge vision interview → derived spec DAG → sources/scheduled-audits/arrival. Supersedes the P2B-0009 thin stretch form. _Depends:_ P3-0010 + P3-0013 + hi-fi greenfield interview.
- **P3-0016 brownfield-onboarding-full** — recon agent (read-only repo index → personas/behaviors/architecture/risks) + **config-injection PR** (adds `tanren-ci.yml`/`.mergify.yml`/`CODEOWNERS`/`.tanren/PROJECT.md`) + DAG seed + governance picker. _Depends:_ P3-0003 + P3-0004.
- **P3-0017 tanren-config-audit-gate** — optional org toggle routing Bucket-B config writes through a PR in a separate `tanren-config` repo. _Depends:_ hi-fi audit-gate. _Ops:_ a `tanren-config` repo.
- **P3-0018 subscription-window-heatmap** — 30-day × 5-window heatmap + avg-fill + overnight-audit prompt on the costs page.
- **P3-0019 dora-metrics-panel** — lead time, deploy frequency, change-failure rate, MTTR (reported, not targeted).
- **P3-0020 additional-workflow-insights** — `stuck` (P2A-0018 dependency-chain analysis) + `review_stall` (P3-0008 review polling). _Depends:_ P3-0008.
- **P3-0021 scheduled-audits-library** — cron background scans (security/mutation/perf/deps/type-coverage/a11y/license/stale-specs) → auto-generated specs. _Depends:_ P3-0001 (executor) + P3-0014.
- **P3-0022 issue-source-ingestion** — GitHub Issues → candidate specs via label classification (Linear/Jira/webhooks defer). _Depends:_ P3-0014.
- **P3-0023 external-push-governance** — strict/open/audit-only modes for coexistence with non-Tanren contributors. _Depends:_ P3-0008.
- **P3-0024 notification-channels-rollout** — Slack + GitHub Checks next, then teams/discord/email/twilio/pagerduty/webhook (matrix already accommodates, P2A-0017). _Ops:_ channel credentials.
- **P3-0025 live-preview-deploys** — device-tab iframe → per-PR preview URL in Review. _Depends:_ P3-0008.
- **P3-0026 acceptance-hard-tier** — fixture-hard (re-plans, auditor-rejection loops, conflict resolution); final v0 acceptance gate. _Depends:_ P3-0001…0008.
- **P3-0027 allocator-expansion** — remote allocators (manual-SSH, Hetzner, DigitalOcean, AWS EC2, Kubernetes pool), pool policies, label→allocator routing. _Ops:_ cloud credentials.
- **P3-0028 ci-queue-hardening** — required-check awareness, webhook-driven CI, rate-limit handling, queue lease recovery (heartbeats, retry budgets, dead-letter events). _Strengthens:_ P3-0001/0008.
- **P3-0029 observability** — latency/rate-limit/queue-wait/provider/SSH/GitHub timings; coverage thresholds for workflow-critical modules; regression corpus from Phase 2 audit findings.
- **P3-0030 deployment-hardening** — cloudflared exposure profile, TLS termination, Vault enterprise rotation, Authentik OIDC as a second identity provider on P2A-0003. _Ops:_ infra/OIDC setup.

## Hi-fi prerequisites (design-blocking; lock before building the dependent specs)

Per the execution plan: **thick-Forge interaction model + spec discovery
(P3-0010/0014), DAG-primary project view (P3-0013), review→merge flow
(informs P3-0008), greenfield Forge interview (P3-0015), `tanren-config`
audit gate (P3-0017)** must have locked hi-fi/design before those surfaces are
built. Tier 1 is **not** design-blocked (the loop machinery is specified by the
existing engine contracts + the live acceptance evidence) — it can start now.

## Sequencing & parallelization

1. **Wave F1 (parallel):** P3-0002, P3-0003, P3-0004, P3-0006, P3-0007 — independent foundations (credential resolution, GitHub App, CI config, bootstrap, checker reframe). Each its own PR through CI.
2. **Wave F2:** P3-0001 (run executor) integrates F1; P3-0005 (in-loop gate) builds on P3-0004 + P3-0006.
3. **Wave F3:** P3-0008 (review + merge) — the XL completion half.
4. **Wave F4:** P3-0009 — the real Phase 2 closeout demo on the live loop.
5. **Tier 2:** scheduled after F4, gated per-spec on hi-fi prerequisites; sequence by product priority (likely P3-0012/0010 thick-Forge + providers, then DAG/discovery, then onboarding, then observability/hardening).

## External / ops dependencies (not code)

GitHub App registration + per-org install (P3-0003); `tanren-ci.yml` (and
`.mergify.yml`/`CODEOWNERS`) committed to target repos (P3-0004/0016); provider
API keys (P3-0012); a `tanren-config` repo (P3-0017); notification channel
credentials (P3-0024); cloud allocator credentials (P3-0027); Authentik/OIDC +
TLS/Vault rotation (P3-0030).

## Effort signal (rough)

Tier 1 foundational slice ≈ **3–5 weeks** (P3-0008 review/merge is XL; P3-0001
and the gate-check cluster are M–L; P3-0002/0006/0007 are S–M). Full Phase 3
(Tier 1 + the 21 Tier-2 specs) ≈ **3–4 months** at historical velocity.
