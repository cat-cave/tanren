# Tempering — the live forward tracker

**Tempering** is the phase that took Tanren from a forged-but-soft skeleton
(Phases 0–3 merged, but with fakes propping up the runtime and the live gate
never closed) to a **real, fake-free, self-validating platform that delivers
merged PRs** — proven live across easy, medium, and hard tiers with real agents
and real credentials.

The name is the honest translation of the project's own: 鍛錬 (_tanren_) is
forging through disciplined repetition; _tempering_ is the heat-treatment that
turns a forged-but-brittle blade into one you'd stake something on. This phase
removed the softness (every fake, every legacy fallback) and proved the edge
holds — three times, on real repos, including a private one.

This is the **single live to-do**. It supersedes the prose status that used to
live at the top of `forward-roadmap.md`; that doc remains the detailed
four-dimension reference. `ROADMAP.md` carries the phase history;
`PROJECT_BRIEF.md` carries the durable vision.

> **The next major effort — `docs/roadmap/autonomy-engine.md`.** Tempering proved
> the run loop (one spec → merged PR, three tiers). A 2026-06-01 audit found that
> the surrounding **product engine** is not yet autonomous: there is no DAG-walker
> (execution is pull, one operator trigger per spec), the Forge ideation agents
> default to deterministic stubs (real-LLM answerers exist but are unwired), issue
> ingestion is manual, and merge coordination (auto-rebase, conflict resolution,
> stacking) is scaffolded or absent. The autonomy-engine doc is the full plan to
> close that — plus two new standing guardrails: a **stub-ban architecture lint**
> (stubs/shells/mocks are test-fixtures-only, enforced) and a **real-resource,
> real-credential tagged e2e gate** (`just e2e`) that cannot pass unless Tanren
> does real work end-to-end. Its capstone is `apex`, the max-difficulty fixture.
>
> **Status — Phases 1 AND 2 of the autonomy engine are merged on `main`.**
>
> - **Phase 1 — the autonomy core** (2026-06-01, PRs #220–#226): budget-is-the-gate
>   (`QuotaPolicy` deleted, concurrency env→config), the autonomous **DagWalker** +
>   conformance, persisted spec **priority**, **real-LLM Forge** (deterministic
>   answerers → `tests/fixtures/`), **webhook-first autonomous intake**, the
>   **stub-ban lint** (`no-production-stubs`), and the **real-resource `just e2e`
>   gate** + no-mock arch check.
> - **Phase 2 — native merge coordination** (2026-06-02, PRs #228–#236): the
>   **`VcsProvider` seam**, **auto-rebase**, **DAG-aware intent-preserving conflict
>   resolution**, **speculative execution** + **change-percolation**, the **native
>   intelligent merge queue** (DAG-order serialized merge + speculative batch-check +
>   bisect), **CI-intelligence parity** (flaky-quarantine · CI analytics · queue
>   stats), and **Mergify removed entirely** (`native_queue` is the merge engine).
>   Each unit was adversarially verified before merge; four real merge-safety
>   defects were caught and fixed in review.
>
> **Only Phase 3 — `apex` — remains** (the max-difficulty fixture: rough notes →
> deployed product autonomously). It is gated on the real Tier-1 credentials
> (GitHub App + Slack + a deploy target) and spends real credits under the $50
> ceiling. See `docs/operator-guide/validation-credentials.md`.

## Definition of done — real-user-ready (status: MET for the core)

A fresh operator (even the owner, for a side project) can — with **no source
edits, no DB surgery, no CLI workarounds**:

1. Bring up the stack (`just up-dev`, or the prod profile).
2. **Onboard** through the dashboard or CLI: sign in, create an org, import real
   provider credentials (Codex / Claude / opencode) + GitHub access. Durable —
   survives an orchestrator restart (Vault-backed credential registry).
3. **Link a repo** — public **or private** — and choose its integration policy
   (CI / review / merge tier).
4. **Submit a spec** and trigger a run.
5. Watch it go `plan → real-agent write → check → audit → in-loop gate → draft
PR → CI → review → merge` — entirely through real adapters.
6. Inspect **full event / cost / provenance traces**.

✅ **Proven end-to-end on three real fixtures** (easy → medium → hard, the last
private) with real credentials. The remaining items below are hardening, content,
and long-horizon work — none block this.

## Invariants (binding on every change)

- **No legacy / backwards-compat / fallback code, ever.** Tanren has zero real
  users; DB volume wipes/resets are expected and encouraged. Compat shims are
  pure complexity for zero payoff — deleted on sight, never added. Config rows
  are explicitly versioned and fail hard if not.
- **Fakes are test fixtures only** — never constructed in runtime source. The
  hello workflow and all fake adapters were purged from the runtime.
- **Validation uses real credentials** — no faking in anything labeled validation.
- **Integration is per-project configurable** — CI / review / merge is data
  (`governancePosture` × `mergeIntegration` × `reviewPolicy`), not hardcoded.
- **CI is the gatekeeper** — no merge without green `just ci` + `just smoke` and
  up-to-date with `main`. One unit of work per PR; serialize any PR touching a DB
  migration or a shared file.
- **Tenant writes from the de-privileged data plane route through the control
  plane**; tenant queries run org-scoped or RLS returns zero rows.

## Done (this is real, on `main`)

### Native delivery — Action-less (v21) ✅

Tanren owns the delivery operating model end-to-end; there is no GitHub Actions in
the delivery path. All merged on `main` (PRs #323–#334):

- **The native gate is the merge authority.** `.tanren/ci.yml` (a `CiConfigV1`,
  not an Actions workflow) declares tiered shell checks; the orchestrator runs them
  itself over SSH (`engine/workflow/gate/`); the `pre_merge` tier admits the merge
  and the verdict publishes to the forge as a `tanren/gate` check
  (`engine/workflow/plannerRunCi.ts`). The dead Actions path was pruned and JUnit
  is ingested in-process (#329, #330). `docs/operator-guide/ci-config.md`.
- **DeployAdapter + demos-as-evidence.** `engine/contracts/deployAdapter.ts`
  (provision-or-bind · `verify` poll-to-READY + URL smoke · `demoSurface`),
  deploy-on-merge (`engine/postMerge/deployOnMerge.ts`), and the demo engine
  (`engine/demo/`) recording per-behavior evidence tied to the spec's declared
  behaviors (#323, #327). `docs/operator-guide/deploy.md`.
- **Brownfield workflow-intent importer + migration-risk report**
  (`engine/forge/brownfield/`) — migrates _intent_ (not YAML) into native gates
  and classifies each discovered automation migrated/replaced/dropped/blocked (#325).
- **Audit-evidence + security baseline** in the event store
  (`engine/events/schemas/audit.ts`): every governing decision (gate/deploy/merge)
  carries a non-secret actor + governance-policy-version envelope (#331).
- **Named execution-backend substrate seams** — `CommandSubstrate` /
  `FileSubstrate` / `CredentialMaterializer` / `UsageMeter` / `ReleaseFinalizer` /
  `RunnerHandle` (`engine/contracts/`), so a future non-SSH backend slots in as an
  impl, not a refactor (#332).
- **Unified status vocabulary** — one canonical run/spec/task status enum
  (`engine/state/`); a successful run ends at `completed` (no second `done`) (#334).

### A — Core run loop ✅

- The harness-integration frontier that paused the project (`All configured
authentication methods failed`) is **resolved** — durable Vault-backed
  credential registry restored runner-identity resolution.
- The full real loop runs through the run worker with real Codex; **convergence**
  is reliable (the planner emits actionable subtasks; the checker defers
  test/build/lint-outcome criteria to the deterministic gate; the writer's diff
  is judged against the post-bootstrap run base, so replanned already-done work
  and install artifacts aren't false-rejected).
- **Workspace clone authenticates** the GitHub token over HTTPS (token via stdin
  / `GIT_ASKPASS`, never on the command line) → **private repos work**.
- The built worker's real (non-fake) path was hardened end-to-end: bootstrap
  skips when there's no manifest and prefers npm; the runner image carries pnpm;
  answerer JSON schemas are copied into `dist`; `.claude/` is excluded from the
  Docker build context.
- **Tiered integration proven:** easy (`open` / `direct_merge` / `auto`), medium
  (same + a two-tier `.tanren/ci.yml` native gate), hard (same + `reviewPolicy: simulated` —
  the orchestrator-managed reviewer posts a real GitHub `COMMENT` review and
  drives the verdict internally, self-PR-safe). `markReadyForReview` un-drafts
  via the GraphQL ready mutation.
- **Post-merge auto-issue creation** ✅ (the last core run-loop item). After a
  run's PR merges, `engine/postMerge/watcher.ts` re-reads the post-merge CI on the
  base branch (same `evaluateCiObservation` evaluator + `VcsProvider.readBranchChecks`
  as the run/queue poll) for the merge commit; on FAILURE it opens ONE tracking
  issue via `VcsProvider.createIssue` (label `tanren:post-merge-failure`) and
  records `merge.post_merge_failed` + `issue.opened`. Idempotent via a claim store
  - prior-`issue.opened` check (never spams); woken on the same run-activity bus
    the DagWalker / MergeCoordinator listen on (not a new poller).

### B — Benchmark toolkit ✅ (code-complete; seed corpus is the remaining content)

A first-class, permanent capability for measured process-tuning — **not** a
one-off study. `docs/roadmap/tanren-method-benchmark.md` is the design.

- **Entities** `experiments` / `experiment_cells` / `experiment_trials`
  (`db/src/schemaBenchmark.ts`, `engine/benchmark/entities.ts`), RLS-scoped,
  migration `0033`.
- **`TrialScorecard`** projection over the existing run/event/cost data
  (`engine/benchmark/scorecard.ts`) and **`deriveCellScorecard` / `compareCells`**
  reducers — median + bootstrap CI, Mann–Whitney U, one-knob-invariant refusal
  (`engine/benchmark/reducers.ts`, `stats.ts`).
- **`BenchmarkRunner`** (`engine/benchmark/runner.ts`) schedules trials through
  the existing run worker (no second executor), spacing them per the
  comparability invariants + real rate limits; the **post-merge hidden-`accept`
  step** (`accept.ts` / `liveAccept.ts`) allocates → clones @ merged SHA →
  bootstraps → runs the frozen accept tier over SSH and emits
  `benchmark.accept.{passed,failed}` (migration `0034`); terminal-await is
  `LISTEN/NOTIFY`-driven (`liveAwait.ts`).
- **CRUD + report surface** — `tanren experiments create|list|get|run|report|compare`,
  `tanren cells create|list`, and the org-scoped `/orgs/:orgId/experiments[/cells]`
  routes. `compare` returns `422 one_knob_violation` when cells differ in >1
  frozen-config dimension.

### C — DAL / scale prepwork (in progress) ✅ for the migrated clusters

- **`Repositories` seam** + conformance suite
  (`engine/contracts/repositories.ts`, `tests/conformance/repositories*`). The
  HTTP routes (projects/specs/entities/runs/dora) and the run-lifecycle writes
  are migrated off raw SQL; per-entity stores live in `engine/repositories/**`.
- **`LISTEN/NOTIFY`** replaced the 1s polling in the run worker + SSE source.
- Conformance suites exist for Allocator / JobQueue / EventStore / SecretStore /
  CostResolver / Repositories.

### D — Managed-hosting de-privilege ✅ for the lifecycle + allocator

- **RLS** fully DB-enforced + live-validated (roles `tanren_app` /
  `tanren_system`; migrations `0029`/`0030`; `db/src/orgScope.ts`).
- **Plane split P1 → P3c.** Events / cost records (P3b, migration `0031`) **and**
  run/spec/task lifecycle writes (P3c, migration `0035`) route through the
  control-plane `/internal/*` endpoints; the `tanren_dataplane` role's write
  grants on all of those are dropped, proven by `42501` negative tests
  (`smoke-plane-split-p3b` / `-p3c`).
- **Standalone allocator org-threading** — the allocator service writes `runners`
  rows under `runWithOrgScope` on the restricted app-role pool; system pool only
  for genuinely cross-org sweeping (`smoke-rls-allocator`).
- **Durable credential registry** — Vault-backed, survives restart; needed
  `SecretStore.list(prefix)` (added across all backends). Legacy top-level import
  routes deleted; the org-scoped surface is the only import path.
- **Vault per-run scoped credentials** ✅ — the last big de-privilege. Before a run
  touches any credential, `VaultRunTokenMinter` (under the broad token, at boot)
  writes a per-run ACL policy granting `read` on EXACTLY this run's KV-v2 cred
  paths (one stanza per ref, never a glob) and creates an orphan child token
  carrying only that policy (`ttl` · `num_uses` · `renewable:false` · `no_parent`);
  the run's `SecretStore` is swapped for a `VaultSecretStore` backed by THAT scoped
  token (`applyScopedRunCredentials`), built at boot via `buildRunCredentialScoping()`
  and threaded executor→workflow. The broad token is never returned/attached/logged.
  Non-Vault backends (already tenant-namespaced) pass through unchanged. The
  `?? "dev-root-token"` fallbacks in `main.ts` + `allocator/main.ts` are removed —
  the broad token is REQUIRED, fail-hard. (Conformance + unit tests:
  `vaultTokenMinter.conformance` · `vaultPerRunScopedCreds`.)
- **Integration provisioning — pre-apex wiring** ✅ (two-plane model;
  `docs/roadmap/integration-provisioning.md`). Foundation + 4 apex-relevant
  providers (Sentry/Deploy/Slack/Hetzner) + the pre-apex wiring all merged: P-INT-2
  onboarding wires provisioners (capabilities, not leaf secrets; atomic upsert on
  partial unique indexes; `integration.provisioned`), P-APP-ENV-1 app env → CI
  Actions secrets (`crypto_box_seal`), P-APP-ENV-2 runtime env → deployed app, P-INT-6
  webhook signing (HMAC-SHA256). Apex can run on the real provisioned path.

### Hygiene ✅

No-fake/no-legacy purge complete (hello + fake adapters out of runtime → tests;
config migration shims deleted → fail-hard on unversioned rows; secret-store
misconfig fallbacks removed, `TANREN_SECRET_STORE` required; bare-ref compat
removed; `FakeEventStore` → tests). Real-writer-only runtime path; routing-driven
adapters select the writer/answerers from the project routing table.

## Remaining (near-term)

| Item                                          | Dimension | Notes                                                                                                                                                                                            |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Benchmark seed corpus**                     | B         | Tiered seed repos + hidden content-addressed `accept` tiers + reference paths (`tanren-method-benchmark.md` §4.3). The benchmark code is done; this is the content that makes it produce signal. |
| **Remaining DAL clusters**                    | C         | `engine/forge/**` (`audits/store.ts`, `inbox/store.ts`) raw query sites onto the `Repositories` seam. (`engine/recovery/**` carries no raw SQL; `engine/quota/**` is gone — deleted in P1·0.)    |
| **First whole-repo `mutation-full` baseline** | C         | `just mutation-full` + the weekly job exist; capture the first full-repo number + add dashboard/routes clusters.                                                                                 |
| **Type-sharing + `typify → serde` codegen**   | C         | SSE frame + dashboard-only shapes; a Rust impl shares the neutral JSON-Schema.                                                                                                                   |

## Remaining (long-term / held — explicit triggers, not the calendar)

- **Vault as a first-class compose hardening** + rotating the DEV/CI default role
  passwords out-of-band for prod (`docs/operator-guide/deploy.md`).
- **The benchmark experiments** themselves (B3 standing regression-detector) —
  run the toolkit across the corpus to pre-tune Tanren's default knobs (strict
  typing / gate strictness / cheap-models-only / checker-auditor strictness vs
  DORA). Real-cost-gated.
- **GitLab / VCS-provider abstraction**
  (`docs/roadmap/vcs-adapterization-plan.md`) — **held** until a real second
  backend. Delivery is already native (the merge queue is Tanren's own; the gate
  runs over SSH and publishes a `tanren/gate` check — no Actions). What remains
  GitHub-coupled is the thin VCS surface itself: PR/review APIs, check/status
  publication, and clone/push auth behind the `VcsProvider` seam.
- **agy / pi / reasonix live harness validation** — pi/reasonix writer-only
  adapters are built; agy is deferred (broken headless). Awaits credentials.
- **The Rust rewrite / native harness** — long-horizon. The prepwork
  (contracts-as-durable-asset: behavior + conformance tests, neutral
  JSON-Schema, the harness protocol, mutation testing) is the durable asset;
  `docs/architecture/future-refactor-and-scale.md` is the 10 → 1M north-star.
  Trigger: an observed scale bottleneck (single Postgres, the `SKIP LOCKED`
  queue, the SSH substrate, SSE fan-out), not a guess.

## How a fresh clone reproduces the validated state

1. `just up-dev` (fresh DB). Confirm `http://localhost:3100/healthz` and the
   dashboard are healthy.
2. Onboard via the dashboard or CLI (`docs/operator-guide/operator-driven-run.md`,
   `cli.md`, `credentials.md`): create an org, import real Codex/GitHub creds
   through the **org-scoped** surface, link a fixture repo, set the project config
   for the tier you're testing (e.g. `governancePosture: open`,
   `mergeIntegration: direct_merge`, `reviewPolicy: auto` for easy/medium; add a
   `tanren-ci.yml` to the repo for the gate tiers; `reviewPolicy: simulated` for
   hard).
3. Submit a spec and `tanren specs run`. Watch it reach a merged PR.
4. `just smoke` proves the boundaries (connectivity, SSH, plane-split de-privilege
   `42501` proofs, RLS isolation) with no real credentials.

The three fixtures used for the live proof are
`cat-cave/tanren-fixture-{easy,medium,hard}`; the validation walkthrough and the
config gotchas are in `docs/operator-guide/live-validation-findings.md`.
