# Forward roadmap — the four dimensions

The single authoritative forward plan. A fresh clone of `main` can read this
(plus `README.md` + `ROADMAP.md`) and reconstruct **where the project is** and
**what is next**, across four dimensions, without external context.

This doc is the _live_ to-do; `ROADMAP.md` carries the phase history and links
back here. Every status below was verified against the code + git history on
`main`, not inherited from prior docs.

## Status legend

- **done** — built, merged, and (where noted) live-validated.
- **in-progress** — partially built; the remaining slice is named.
- **remaining** — planned, scoped, not started.
- **held** — deliberately deferred (blocked on a credential, a 2nd backend, or
  a long-horizon decision).

## The critical path (read this first)

```
A (finish a real run end-to-end)
   │  unblocks
   ▼
B (experiment + optimize the pipeline)   ← B0 == "land live runs" == finishing A

C (refactor/scale prepwork)   ┐ structural, runs alongside A/B; top items:
D (managed-hosting)           ┘   the data-access layer (C1) + P3c & Vault per-run
                                   creds (D) are the two highest-leverage builds
```

**A is the gate.** The live run is paused at the harness-integration frontier
(below). Until a real run goes plan → write → draft-PR → CI → merge, B cannot
start (B0 _is_ A) and D's remaining de-privilege can't be live-proven. C is
structural and proceeds in parallel.

---

## A. Core functionality — finish a real run end-to-end

The dashboard- and CLI-triggered run path is built and merged (the background
run worker `TANREN_RUN_WORKER=1`, `services/orchestrator/src/engine/worker/`,
dequeues `plan` jobs and drives plan → write → check → audit → in-loop gate →
draft PR → review → merge). A live operator-driven validation run was executed
and got as far as **signup → CRUD → run → mTLS claim → credential resolution →
runner allocation** before stopping at the harness frontier. Findings:
`docs/operator-guide/live-validation-findings.md`.

**The harness-integration frontier (remaining — the true P3-0009 close-out):**

1. **Workspace git-clone / worker→runner SSH auth** — the live run failed with
   `All configured authentication methods failed`. The worker cannot yet
   authenticate the workspace clone / runner SSH in the live path. _(remaining)_
2. **The real write stage** — drive a real `codex` / `claude` / `opencode`
   writer against the cloned workspace and produce a diff. _(remaining)_
3. **Draft-PR push → CI poll → review → Mergify merge** — push the draft PR,
   poll `tanren-ci.yml` via GitHub Actions, route review, and let Mergify merge.
   This is the real close-out of the P3-0009 live demo. _(remaining)_

**Operability gaps the live run surfaced:**

- **Durable credential registry (remaining).** The default
  `InMemoryCredentialRegistry`
  (`services/orchestrator/src/routes/credentials/index.ts`) is a `Map` that does
  **not** survive an orchestrator restart, and the legacy top-level import
  routes write to the secret store without a registry `put`. A durable
  Vault-backed registry needs a `SecretStore.list(prefix)` contract method (the
  interface comment already flags this); it is a follow-up, **not** an RLS bug.
- **Fresh-repo onboarding UX (remaining).** Smooth the existing-project
  onboarding path validated against a real repo.

**Held:** hi-fi "Set 2" surfaces await the next hi-fi revision
(`docs/design/hifi-revision-process.md`); agy/pi/reasonix **live** validation
awaits credentials (the pi/reasonix writer-only adapters are built; agy is
deferred — broken headless; no agy adapter exists in `engine/providers/`).

---

## B. Experimentation & optimization of the agentic pipeline

The **tanren-method benchmark** — does the _process_ (strict typing, gate
strictness, cheap-models-only, checker/auditor strictness) move DORA-style
delivery metrics? Full scoping (incl. a verified ProgramBench comparison):
`docs/roadmap/tanren-method-benchmark.md`.

- **B0 — land live runs (remaining, == finishing A).** The hard prerequisite.
  No benchmark code; the benchmark needs a real run to score.
- **B1 — smallest experiment by hand (remaining).** One seed, 2 cells, 1 knob,
  N trials, scored by hand.
- **B2 — the harness skeleton (remaining).** Add `experiments` /
  `experiment_cells` / `experiment_trials` entities, the `TrialScorecard`
  projection + `deriveCellScorecard` / `compareCells` reducers, a seed corpus,
  and a thin `BenchmarkRunner` (enqueue trials + post-merge `accept` step).
- **B3 — standing regression-detector (remaining).** Grow the corpus across
  tiers; run continuously to detect process regressions.

**Metrics infra largely exists** (DORA compute, 4-source cost model,
audited-concern / retry signals). Gaps: a deploy-frequency reframe, a post-merge
accept-failure signal, and the net-new `TrialScorecard`. Real-cost-gated.

Open questions the benchmark exists to answer (from the benchmark doc §7): does
strict typing / gate strictness improve DORA or just slow it? Does cheap-models-
only pay off? How does checker/auditor strictness trade against lead time?

---

## C. Codebase prepwork for a future refactor / scale (Rust held)

North-star: `docs/architecture/future-refactor-and-scale.md` (10 → 1M, zero-
trust). The Rust rewrite itself is long-horizon; the prepwork is
**contracts-as-durable-asset** (behavior + conformance tests, neutral
JSON-Schema, the harness protocol, mutation testing). Highest-leverage items:

1. **Complete a true data-access layer (in-progress — biggest structural debt).**
   The RLS work seeded it: `engine/data/orgScopedDb.ts` routes tenant queries
   through the org-scoped client, and `engine/repositories/**` is a _partial_
   DAL. But on the order of ~269 SQL call sites are still not all behind a
   repository abstraction. Finish it, then promote it to a conformance-covered
   `Repositories` seam (like `JobQueue` / `EventStore`).
2. **`LISTEN/NOTIFY` (remaining).** The worker (`runWorker.ts`,
   `DEFAULT_POLL_INTERVAL_MS = 1_000`) and the SSE frame source both poll at a
   1s tick. The SSE contract is already shaped for a Postgres `LISTEN/NOTIFY`
   swap-in (`routes/runs/sse.ts`); wire it to kill the polling.
3. **Finish type-sharing (in-progress).** Dashboard run-detail types are
   generated from the JSON-Schema export with a drift gate
   (`services/dashboard/src/api/types.ts`); SSE frame shapes and dashboard-only
   shapes still need sharing. Add a `typify → serde` codegen + drift check over
   `contracts/json/**` so a future Rust impl shares the same neutral schema.
4. **Backfill conformance suites (remaining).** Four seams have suites
   (`services/orchestrator/tests/conformance/**`: `Allocator`, `JobQueue`,
   `EventStore`, `SecretStore`). `SshSubstrate`, `CostResolver`, and the
   providers have contracts but no conformance suite yet.
5. **First whole-repo `mutation-full` baseline (remaining).** `just
mutation-full` + the weekly `mutation-weekly.yml` job exist; capture the
   first full-repo baseline and add dashboard / routes mutation clusters.

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
- **Plane split P1 → P3b (done).** P1: standalone `worker` deployable. P2: mTLS
  control-plane claim endpoint (`POST /internal/claim-job`). P3a: control-plane
  write endpoints + the `RunStateWriter` seam. P3b: de-privilege — the
  `tanren_dataplane` role (migration `0031`) has `events` / `cost_records` write
  grants **dropped**, proven by a `42501` negative test
  (`planeSplitP3bDeprivilege.integration.test.ts`). Prod compose wires the
  `worker` service + the three roles; prod needs `TANREN_DATAPLANE_DB_PASSWORD`.

**Remaining:**

- **P3c — route the run/spec/task lifecycle writes through the control plane**
  and drop those data-plane grants too. The data plane still writes `runs` /
  `specs` / `tasks` directly via its org-scoped pool. _(remaining)_
- **Standalone allocator SERVICE org threading (remaining).**
  `services/allocator/` does **not** set `org_id` or open an org scope; give it
  org threading + scoping/grants so it runs de-privileged like the worker.
- **Vault per-run scoped credentials (remaining — the biggest remaining
  de-privilege).** The data plane still holds the broad `VAULT_TOKEN`; scope it
  per-run.
- **Durable credential registry (remaining).** Same item as A; it is also a
  hosting hardening item.
- **Prod hardening (remaining).** Rotate the DEV/CI default role passwords
  out-of-band per the migration headers; finalize the prod profile.

**Seams already built (the OSS-enforces / hosting-bills boundary):**
`QuotaPolicy` + metering-export, credential namespacing
(`credential/<slug>/<scope>/<ownerId>/<name>`), the managed-provider toggle
(BYOK ↔ OpenRouter), pluggable secret-stores.

**Held:** the **VCS / CI / merge-integration abstraction**
(`docs/roadmap/vcs-adapterization-plan.md`) — deferred until a real 2nd backend;
GitHub is coupled across PR / merge / CI via Mergify + Actions. It is the
GitLab / Gitea hosting-flexibility lever.
