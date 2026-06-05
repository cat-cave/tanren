# Forward roadmap — the four dimensions

> **The live to-do lives in [`tempering.md`](tempering.md)** — what's done,
> what's next (near- and long-term), and how a fresh clone reproduces the
> validated state. **This doc is the detailed four-dimension reference**
> (more granular than `tempering.md`); align to `tempering.md` + `README.md` on
> any conflict.

The detailed four-dimension plan. A fresh clone of `main` can read this (plus
`README.md`, `tempering.md`, and `ROADMAP.md`) and reconstruct **where the
project is** and **what is next**, across four dimensions, without external
context. `ROADMAP.md` carries the phase history and links back here. Every status
below was verified against the code + git history on `main`, not inherited from
prior docs.

## Status legend

- **done** — built, merged, and (where noted) live-validated.
- **in-progress** — partially built; the remaining slice is named.
- **remaining** — planned, scoped, not started.
- **held** — deliberately deferred (blocked on a credential, a 2nd backend, or
  a long-horizon decision).

## The critical path (read this first)

```
A (a real run end-to-end)   ✅ DONE — live-validated to merged PRs across 3 tiers
   │  unblocked
   ▼
B (experiment + optimize the pipeline)   toolkit ✅ code-complete; needs the seed corpus

C (refactor/scale prepwork)   ┐ structural; DAL seam + LISTEN/NOTIFY landed.
D (managed-hosting)           ┘ Top remaining builds: Vault per-run scoped creds (D)
                                + the remaining DAL clusters (C). P3c + allocator
                                org-threading are DONE.
```

**A is done — it is no longer the gate.** The full real loop went
plan → real-agent write → draft-PR → native gate → review → merge → deploy → demo
to a **merged PR across three tiers** (easy/medium/hard, the hard one a private
repo) with real Codex and real credentials; the harness-integration frontier is
resolved. B's prerequisite
is therefore met and its toolkit is code-complete (only the seed corpus remains);
D's de-privilege is live-proven through P3c. The two highest-leverage remaining
builds are **Vault per-run scoped credentials** (D) and the **remaining
data-access-layer clusters** (C); C proceeds in parallel.

---

## A. Core functionality — a real run end-to-end (DONE)

The dashboard- and CLI-triggered run path is built, merged, and **live-validated
to a merged PR across three tiers**. The background run worker
(`TANREN_RUN_WORKER=1`, `services/orchestrator/src/engine/worker/`) dequeues
`plan` jobs and drives `plan → write → check → audit → native gate → merge →
deploy → demo` with real writer/answerer adapters (Codex/Claude/opencode behind a
versioned harness protocol). Delivery is Action-less: the `pre_merge` gate runs
over SSH and is the merge authority (no injected Actions workflow). Findings +
reproduction: `docs/operator-guide/live-validation-findings.md`.

**The harness-integration frontier is RESOLVED (the P3-0009 close-out is done):**

1. **Workspace git-clone / runner auth (done).** The earlier
   `All configured authentication methods failed` is fixed; the workspace clone
   authenticates the org's GitHub token over HTTPS (token via stdin / `GIT_ASKPASS`),
   so **private target repos work**.
2. **The real write stage (done).** A real `codex` writer runs against the cloned
   workspace and produces a diff judged against the post-bootstrap run base.
3. **Draft-PR → native gate → review → merge (done).** Easy
   (`open`/`direct_merge`/`auto`), medium (same + a two-tier `.tanren/ci.yml`
   native gate run over SSH — no Actions), and hard (same + `reviewPolicy:
simulated`) each reached a merged PR. The `pre_merge` gate is the merge
   authority; the verdict publishes as a `tanren/gate` check.

**Tiered integration proven (`reviewPolicy` = `["human","auto","simulated"]`,
`engine/config/shared.ts`):** the `simulated` reviewer is an orchestrator-managed
Answerer that judges the PR diff against the spec, posts a real GitHub `COMMENT`
review (self-PR-safe), and drives the verdict internally; `markReadyForReview`
un-drafts via the GraphQL ready mutation.

**Operability hardening that landed closing this (done):** durable Vault-backed
credential registry (survives restart; needed `SecretStore.list(prefix)`, added
across all backends — the legacy in-memory `Map` is gone); bootstrap robustness
(skip-when-no-manifest, prefer npm, pnpm in the runner image, answerer schemas
copied into `dist`, `.claude/` excluded from the Docker build context);
cumulative-diff convergence (planner-actionable subtasks; checker defers
test/build/lint outcomes to the deterministic gate).

**Native delivery — Action-less (v21, done).** The delivery model is fully
Tanren-native (PRs #323–#334): the **native gate** is the merge authority
(`.tanren/ci.yml` tiers run over SSH; `tanren/gate` verdict; the dead Actions path
pruned, JUnit ingested in-process); the **DeployAdapter** triggers deploy-on-merge
and `verify` polls to READY + URL smoke; **demos-as-evidence** exercise the spec's
behaviors against the live surface; the **brownfield importer** migrates workflow
_intent_ into native gates with a migration-risk report; the **audit-evidence +
security baseline** stamps every governing decision; the execution-backend
**substrate seams** are named; and the run/spec/task **status vocabulary** is
unified. See `docs/operator-guide/ci-config.md` + `deploy.md`.

**Post-merge auto-issue creation (done).** On a post-merge check failure on the
base branch, `engine/postMerge/watcher.ts` opens ONE tracking issue via
`VcsProvider.createIssue` (label `tanren:post-merge-failure`), idempotent via a
claim store, woken on the same run-activity bus the DagWalker listens on.

**Held:** hi-fi "Set 2" surfaces await the next hi-fi revision
(`docs/design/hifi-revision-process.md`); agy/pi/reasonix **live** validation
awaits credentials (the pi/reasonix writer-only adapters are built; agy is
deferred — broken headless; no agy adapter exists in `engine/providers/`).

---

## B. Experimentation & optimization of the agentic pipeline

The **tanren-method benchmark** — does the _process_ (strict typing, gate
strictness, cheap-models-only, checker/auditor strictness) move DORA-style
delivery metrics? Full scoping (incl. a verified ProgramBench comparison):
`docs/roadmap/tanren-method-benchmark.md`. **The toolkit is code-complete;** only
the seed corpus (content) remains.

- **B0 — land live runs (done == A above).** The hard prerequisite is met.
- **B1/B2 — entities + scorecard + reducers + runner (done, code-complete).**
  `experiments` / `experiment_cells` / `experiment_trials` entities
  (`db/src/schemaBenchmark.ts`, `engine/benchmark/entities.ts`, migration `0033`,
  RLS-scoped); the `TrialScorecard` projection (`engine/benchmark/scorecard.ts`);
  `deriveCellScorecard` / `compareCells` reducers (median + bootstrap-CI +
  Mann–Whitney U, one-knob-invariant refusal — `engine/benchmark/reducers.ts`,
  `stats.ts`); a `BenchmarkRunner` (`engine/benchmark/runner.ts`) scheduling
  trials through the existing run worker (no second executor); the post-merge
  hidden-`accept` step (`accept.ts` / `liveAccept.ts`) emitting
  `benchmark.accept.{passed,failed}` (migration `0034`), with `LISTEN/NOTIFY`-driven
  terminal-await (`liveAwait.ts`); and the CLI/HTTP surface —
  `tanren experiments create|list|get|run|report|compare`,
  `tanren cells create|list`, and the `/orgs/:orgId/experiments[/cells]` routes
  (`compare` returns `422 one_knob_violation` when cells differ in >1 frozen-config
  dimension).
- **B-seed — the seed corpus (remaining, content not code).** Tiered seed repos +
  hidden content-addressed `accept` tiers + reference paths
  (`tanren-method-benchmark.md` §1.2/§4.3). This is the net-new authoring that
  makes the toolkit produce signal. _(remaining)_
- **B3 — standing regression-detector (remaining, real-cost-gated).** Run the
  toolkit across the corpus to pre-tune Tanren's default knobs and detect process
  regressions on a frozen config snapshot.

Open questions the benchmark exists to answer (from the benchmark doc §7): does
strict typing / gate strictness improve DORA or just slow it? Does cheap-models-
only pay off? How does checker/auditor strictness trade against lead time?

---

## C. Codebase prepwork for a future refactor / scale (Rust held)

North-star: `docs/architecture/future-refactor-and-scale.md` (10 → 1M, zero-
trust). The Rust rewrite itself is long-horizon; the prepwork is
**contracts-as-durable-asset** (behavior + conformance tests, neutral
JSON-Schema, the harness protocol, mutation testing). Highest-leverage items:

1. **The data-access layer — a conformance-covered `Repositories` seam exists
   (done for the migrated clusters; remaining clusters named).** The
   `Repositories` seam (`engine/contracts/repositories.ts`, `engine/repositories/**`)
   is promoted alongside `JobQueue` / `EventStore` and has its own conformance
   suite (`tests/conformance/repositories*`). The HTTP routes (projects/specs/
   entities/runs/dora) and the run-lifecycle writes are migrated off raw SQL.
   **Remaining:** the `engine/forge/**` raw-query cluster onto the seam.
   (`engine/recovery/**` carries no raw SQL; `engine/quota/**` is gone — deleted
   with `QuotaPolicy`.) _(in-progress)_
2. **`LISTEN/NOTIFY` (done).** Replaced the 1s polling in the run worker and the
   SSE frame source.
3. **Finish type-sharing (in-progress).** Dashboard run-detail types are
   generated from the JSON-Schema export with a drift gate
   (`services/dashboard/src/api/types.ts`); SSE frame shapes and dashboard-only
   shapes still need sharing. Add a `typify → serde` codegen + drift check over
   `contracts/json/**` so a future Rust impl shares the same neutral schema.
   _(remaining)_
4. **Conformance suites (done for the core seams).** Suites exist for
   `Allocator` / `JobQueue` / `EventStore` / `SecretStore` / `CostResolver` /
   `Repositories` (`services/orchestrator/tests/conformance/**`). `SshSubstrate`
   and the providers have contracts but no conformance suite yet. _(in-progress)_
5. **First whole-repo `mutation-full` baseline (remaining).** `just
mutation-full` + the weekly `mutation-weekly.yml` job exist; capture the
   first full-repo baseline and add dashboard / routes mutation clusters.
   _(remaining)_

**Scale path 10 → 1M is analysis-done, build-pending.** Named bottlenecks:
single Postgres, the `SKIP LOCKED` queue, the SSH substrate, SSE fan-out.

---

## D. Managed-hosting (open-source / hosting-available)

The OSS repo carries the primitives that make a hosted product _deployable_;
commercial logic (billing, pricing, marketing) stays **out** of the repo. Plan +
live conversion checklist: `docs/roadmap/saas-rls-and-plane-split-plan.md` +
`docs/roadmap/R-WAVES.md`.

**Done + live-validated:**

- **RLS — fully DB-enforced (done, live-validated).** Restricted runtime role
  `tanren_app` (NOBYPASSRLS), narrow `tanren_system` BYPASSRLS pool for
  bootstrap / cross-org reads, deny-by-default `USING` + `WITH CHECK` policies on
  every tenant table. Roles: `tanren_app` (migration `0029`), `tanren_system`
  (migration `0030`); policy enablement + role flip: migration `0030`;
  seam: `db/src/orgScope.ts` (`runWithOrgScope` /
  `runWithSystemScope` / `runWithJobOrgId` / `orgScopingPool`). The live run
  drove signup → CRUD → run → mTLS-claim → cred-resolution → runner-allocation
  and **caught + fixed a class of RLS-completeness bugs the hello-fixture smoke
  missed** (org creation, operator/resource HTTP routes, the run-lifecycle
  allocator write) — each now fixed + regression-tested, including a full
  run-lifecycle-under-RLS test (`just smoke-rls-*`).
- **Plane split P1 → P3c (done).** P1: standalone `worker` deployable. P2: mTLS
  control-plane claim endpoint (`POST /internal/claim-job`). P3a: control-plane
  write endpoints + the `RunStateWriter` seam. P3b: de-privilege — the
  `tanren_dataplane` role (migration `0031`) has `events` / `cost_records` write
  grants **dropped**, proven by a `42501` negative test (`smoke-plane-split-p3b`).
  **P3c (done):** the run/spec/task **lifecycle** writes also route through the
  control-plane `/internal/*` endpoints and those data-plane grants are dropped
  too (migration `0035`, proven by `smoke-plane-split-p3c`). Prod compose wires
  the `worker` service + the three roles; prod needs `TANREN_DATAPLANE_DB_PASSWORD`.
- **Standalone allocator service org-threading (done).** `services/allocator/`
  writes `runners` rows under `runWithOrgScope` on the restricted app-role pool;
  the system pool is used only for genuinely cross-org sweeping
  (`smoke-rls-allocator`).
- **Durable credential registry (done).** Vault-backed, survives an orchestrator
  restart; needed `SecretStore.list(prefix)` (added across all backends). The
  legacy top-level import routes are **deleted** — the org-scoped surface is the
  only import path.
- **Vault per-run scoped credentials (done — the last big de-privilege).** Before
  a run touches any credential, `VaultRunTokenMinter` writes a per-run ACL policy
  granting `read` on exactly that run's KV-v2 cred paths (one stanza per ref) and
  creates an orphan child token carrying only that policy; the run's `SecretStore`
  is swapped for a `VaultSecretStore` backed by that scoped token
  (`buildRunCredentialScoping()` / `applyScopedRunCredentials`,
  `engine/workflow/plannerRunScopedCreds.ts`). The broad token is never returned or
  logged; the `?? "dev-root-token"` fallbacks in `main.ts` + `allocator/main.ts`
  are removed (the broad token is REQUIRED, fail-hard).

**Remaining:**

- **Prod hardening (remaining).** Rotate the DEV/CI default role passwords
  out-of-band per the migration headers; finalize the prod profile.

**Seams already built (the OSS-enforces / hosting-bills boundary):**
the **budget gate** (the only run gate — `QuotaPolicy` is deleted) + metering-export,
credential namespacing (`credential/<slug>/<scope>/<ownerId>/<name>`), the
managed-provider toggle (BYOK ↔ OpenRouter), pluggable secret-stores.

**Held:** the **VCS-provider abstraction**
(`docs/roadmap/vcs-adapterization-plan.md`) — deferred until a real 2nd backend.
Delivery is already native (Tanren's own merge queue + SSH gate + `tanren/gate`
publication; no Mergify, no Actions). What remains GitHub-coupled is the thin VCS
surface behind the `VcsProvider` seam: PR/review APIs, check/status publication,
clone/push auth. It is the GitLab / Gitea hosting-flexibility lever.
