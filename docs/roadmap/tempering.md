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
  (same + a two-tier `tanren-ci.yml`), hard (same + `reviewPolicy: simulated` —
  the orchestrator-managed reviewer posts a real GitHub `COMMENT` review and
  drives the verdict internally, self-PR-safe). `markReadyForReview` un-drafts
  via the GraphQL ready mutation.

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

### Hygiene ✅

No-fake/no-legacy purge complete (hello + fake adapters out of runtime → tests;
config migration shims deleted → fail-hard on unversioned rows; secret-store
misconfig fallbacks removed, `TANREN_SECRET_STORE` required; bare-ref compat
removed; `FakeEventStore` → tests). Real-writer-only runtime path; routing-driven
adapters select the writer/answerers from the project routing table.

## Remaining (near-term)

| Item                                          | Dimension | Notes                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vault per-run scoped credentials**          | D         | The data plane still holds a broad `VAULT_TOKEN`; mint a short-lived child token scoped to a single run's cred paths. The last big de-privilege. (Also: `main.ts` + `allocator/main.ts` still have `?? "dev-root-token"` fallbacks to remove.) |
| **Benchmark seed corpus**                     | B         | Tiered seed repos + hidden content-addressed `accept` tiers + reference paths (`tanren-method-benchmark.md` §4.3). The benchmark code is done; this is the content that makes it produce signal.                                               |
| **Remaining DAL clusters**                    | C         | `engine/forge/**`, `engine/quota/**`, `engine/recovery/**` raw query sites onto the `Repositories` seam.                                                                                                                                       |
| **Post-merge auto-issue creation**            | A (hard)  | On a post-merge check failure, auto-open a tracking issue. (The merge-queue + human-review paths already exist.)                                                                                                                               |
| **First whole-repo `mutation-full` baseline** | C         | `just mutation-full` + the weekly job exist; capture the first full-repo number + add dashboard/routes clusters.                                                                                                                               |
| **Type-sharing + `typify → serde` codegen**   | C         | SSE frame + dashboard-only shapes; a Rust impl shares the neutral JSON-Schema.                                                                                                                                                                 |

## Remaining (long-term / held — explicit triggers, not the calendar)

- **Vault as a first-class compose hardening** + rotating the DEV/CI default role
  passwords out-of-band for prod (`docs/operator-guide/deploy.md`).
- **The benchmark experiments** themselves (B3 standing regression-detector) —
  run the toolkit across the corpus to pre-tune Tanren's default knobs (strict
  typing / gate strictness / cheap-models-only / checker-auditor strictness vs
  DORA). Real-cost-gated.
- **GitLab / VCS-provider abstraction**
  (`docs/roadmap/vcs-adapterization-plan.md`) — **held** until a real second
  backend; GitHub is coupled across PR / merge / CI via Mergify + Actions.
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
