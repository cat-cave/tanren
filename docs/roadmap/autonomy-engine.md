# Autonomy Engine — making the DAG real

This is the plan to take Tanren from a **parallel spec-execution engine with a
manual driver and a templated ideation front-end** to the thing it claims to be:
**a clean repo → autonomous product delivery engine**, where a product brief
becomes a roadmap DAG that executes itself — specs triaged, prioritized, run in
parallel, merged with DAG-aware coordination, and fed by an autonomous
issue-ingestion loop, all under live budget/DORA/visibility.

It is the largest remaining body of work in the project. It is scoped here in
full **before** any code, with PR-sized units and dependencies, so it can be
reviewed and sequenced deliberately. The capstone is `apex` — a max-difficulty
fixture that forces every capability below and proves the end-to-end claim.

## 0. The honest gap (from the 2026-06-01 autonomy audit)

What is **real** today (proven by the easy/medium/hard live runs): the
`plan → write → check → audit → gate → draft-PR → CI → review → merge` loop with
real-LLM writer/answerers, **parallel execution** (the worker runs N concurrent
slots, `engine/worker/runWorker.ts` `DEFAULT_CONCURRENCY=2`, env-tunable), real
cost/token accounting, real workflow insights, and the de-privileged plane split.

What is **not** real / not autonomous:

| Capability                                      | Status today                                                                                                                                                                             | Severity |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **DAG-walker** (auto-select & enqueue specs)    | NOT BUILT — execution is pure pull; an operator calls `POST …/specs/:id/runs` per spec. Deps only gate-at-trigger (`projectSpec.ts` `ensureSpecDependenciesDone`).                       | CRITICAL |
| **Real-LLM Forge** (interview/discovery/triage) | STUB-ONLY in prod — all default to `createDeterministic*Answerer`; the real `wrapProvider*Answerer` exist but are **never injected** (`mountFeatureRoutes` passes no `answererFactory`). | CRITICAL |
| **Discovery proposals**                         | Hardcoded templates ("add csv export", "fix session race"). No LLM decides _what to build_.                                                                                              | CRITICAL |
| **Issue ingestion**                             | Manual `POST …/inbox/sources/:id/ingest` only. No scheduled poller. Audit scheduler isn't on a loop.                                                                                     | CRITICAL |
| **Priority**                                    | A discovery-output field that is **never persisted on the spec and nothing reads** to order execution.                                                                                   | HIGH     |
| **Auto-rebase / up-to-date before merge**       | NOT BUILT — `directMerge` calls merge once; a stale branch surfaces as a 405/409 conflict.                                                                                               | HIGH     |
| **Conflict resolution**                         | Hook scaffolded (`mergeDispatch.ts` `resolveConflict?`), default is `noopConflictResolver`. No resolver.                                                                                 | HIGH     |
| **Stacked / chain PRs + dynamic base**          | NOT BUILT — every PR targets `projects.default_branch` (`githubDraftPr.ts`).                                                                                                             | HIGH     |
| **Merge queue**                                 | PARTIAL — `mergify_queue` applies a label and hands off to an external Mergify app; Tanren manages nothing.                                                                              | MEDIUM   |
| **Forge ⌘K / narration**                        | Templated v0 (`forge/narration/v0.ts`); real Answerer exists but unwired.                                                                                                                | MEDIUM   |

The co-dependency that drives sequencing: **the moment the DAG-walker turns on,
parallel specs on a young repo collide constantly** — so auto-rebase and
conflict resolution are not optional Phase-2 polish, they are the immediate
consequence of Phase 1 working.

## 1. Architectural principles

1. **Native-first, pluggable seam.** Tanren owns merge coordination natively
   (auto-rebase, conflict resolution, stacking, ordering) behind a
   `MergeCoordinator` contract. An **external merge queue** (Mergify today,
   GitLab/others later) is a _configured delegate_ of the ordering/batching
   role — not a replacement for the differentiated capability.
2. **Conflict resolution is always native + intent-preserving.** A mechanical
   resolver (Mergify, `git rerere`) can only pick text. Tanren's resolver has
   the **acceptance criteria + intent of _both_ conflicting specs** and the DAG
   edge between them, so it resolves to satisfy **both intents** and re-runs the
   checker/auditor/gate against the merged result. This stays native even when
   the _queue_ is delegated, because no external tool can preserve spec intent.
3. **Everything is an event-driven reaction.** The autonomy layer reacts to the
   `run.*` / `merge.completed` events already on the `LISTEN/NOTIFY` bus — no new
   polling. A spec finishing fires the walker; a merge firing re-checks
   dependents' freshness.
4. **Contracts-as-durable-asset.** Each new capability is a seam with a
   conformance suite (like `Allocator`/`JobQueue`/`Repositories`), so the
   external-queue adapter, a future GitLab VCS, and the Rust rewrite all slot in.
5. **DAG state is the source of truth.** Priority, readiness, and stacking are
   derived from persisted spec/dependency rows under RLS — not held in memory.

## 2. Phase 1 — the autonomy core (makes the DAG real)

### 1a. The DAG-walker (the keystone)

A background **`DagWalker`** per project that turns the DAG into self-driving
execution. On startup and on every `run.*`-terminal / `merge.completed`
notification for the project, it:

1. Loads the project's spec DAG (specs + `dependsOn` edges + status).
2. Computes the **ready set** — specs `pending` whose every dependency is `done`.
3. Orders the ready set by **priority** (1b) then a deterministic tiebreak.
4. Enqueues up to (concurrency − in-flight) ready specs via the existing
   `createQueuedRunFromSpec` path — the **same** parallel worker runs them.
5. Stops a project when the DAG is drained or a milestone boundary needs a gate.

It is a _scheduler over the existing executor_, mirroring how `BenchmarkRunner`
already schedules trials — no second executor. It must be idempotent (a spec
already in-flight is never re-enqueued), respect a per-project concurrency cap
distinct from the global worker cap, and emit `dag.spec.enqueued` /
`dag.milestone.completed` / `dag.drained` events for visibility.

**Seam:** `engine/dag/walker.ts` + a `DagWalker` contract + conformance suite.
Wired into the worker boot as a long-lived per-project subscriber.

### 1b. Persist + honor priority

Add a `priority` (`P0|P1|P2|tbd`) column to `specs` (migration), thread it
through `createSpec` and the discovery/triage acceptance path (it already exists
on `ProposedSpec`), and have the `DagWalker` order the ready set by it. This is
what makes "prioritized around" real instead of FIFO.

### 1c. Wire real-LLM Forge

Inject the existing `wrapProviderInterviewAnswerer` / `wrapProviderDiscoveryAnswerer`
/ provider triage answerer (and the brownfield recon + Forge-conversation
provider answerers) into their routes via the `answererFactory` the routes
already accept, resolved from the project's routing table (the same role-routing
the run loop uses; default Codex/Claude). The deterministic answerers **move to
test fixtures** (per the no-fake-in-prod rule) — production ideation must reason
with a model. This turns interview → personas/behaviors/milestones, discovery →
a real derived DAG, and triage → real candidate judgment into live LLM behavior.

> A real LLM may produce an invalid plan; the schema-validated Answerer contract
> already rejects non-conforming output. Where a deterministic _grounding_ step
> is genuinely valuable (e.g. read-tools feeding the LLM context), keep it as a
> pre-step that feeds the model, not as the answer itself.

### 1d. Scheduled, autonomous ingestion

A background **ingestion scheduler** (generalizing `forge/audits/scheduler.ts`)
that, per configured source, polls the connector → runs (now real-LLM) triage →
auto-routes `auto_routable` candidates into specs and **inserts them into the
DAG** with dependencies + priority; everything else lands in the candidate inbox
for operator review. Interval + per-source config; respects rate limits and
budget. This closes the issue-driven loop autonomously.

## 3. Phase 2 — merge coordination (native, pluggable)

Driven into existence by Phase 1: once specs run in parallel, they go stale and
collide. A `MergeCoordinator` contract owns this; the run path's merge stage
calls it instead of the bare `directMerge`.

### 2a. Up-to-date enforcement + auto-rebase

Before a merge, ensure the PR branch is current with its base; if behind,
**auto-rebase/update** it (native `git rebase --onto` over the runner, or the
GitHub `update-branch` API as a fast path) and re-poll CI. Replaces the current
"merge once, surface 405/409" behavior.

### 2b. DAG-aware, intent-preserving conflict resolution

The differentiated capability, replacing `noopConflictResolver`. On a conflict
between the merging spec and what's now on the base:

1. Identify the conflicting spec(s) via the DAG + the conflicting files' recent
   provenance (which merged run last touched them).
2. Invoke a **conflict-resolution Answerer** (PROJECT_BRIEF §2.2's
   conflict-resolution-planner, enriched) given: the conflict hunks, **both
   specs' intent + acceptance criteria**, and the DAG edge. It produces a
   resolution that **preserves both intents** (or, if genuinely irreconcilable, a
   structured diagnosis that routes one spec back to the planner with the other's
   change as new context — intent stays alive, not dropped).
3. Apply, re-run the in-loop gate + checker/auditor against the resolved tree,
   then merge. The resolution is itself inspectable (events + the diff).

This is the principle made concrete: **the DAG knows the intent of every change,
so a conflict is a re-planning problem, not a text-picking problem.**

### 2c. Stacked / chain PRs + dynamic base targeting

Let a dependent spec target an **upstream spec's branch** (not just
`default_branch`) when the upstream is still open — so dependent work starts
before the parent merges (PROJECT_BRIEF §2.2 chain PRs). The base-branch
selection (today hardcoded to `projects.default_branch`) becomes DAG-derived;
when the parent merges, the child auto-retargets/rebases onto the new base (2a).
This is what makes a deep DAG flow without serializing on every merge.

### 2d. Pluggable merge-queue seam

The `MergeCoordinator`'s **ordering/batching** role is pluggable per project via
`mergeIntegration`: a **native** in-Tanren queue (orders ready-to-merge PRs,
batches CI, serializes conflict-prone merges) as the default, and an **external**
adapter (Mergify: generate/manage `.mergify.yml`, drive its queue) when
configured. Conflict resolution (2b) and intent-preservation stay native in
both modes. This is the "own natively, shell out when configured" decision.

## 4. Phase 3 — `apex` fixture + run + benchmark

### The fixture

`tanren-fixture-apex` — an **empty repo + a one-paragraph product brief** for a
small but genuinely multi-layer service (candidate domain: a URL-shortener with
analytics API, or a domain mirroring the operator's real side project; the
_structural_ requirements are fixed, the domain is flexible):

- **A real dependency DAG** — data model → storage → core logic → API →
  rate-limit → analytics → auth → (optional dashboard) → deploy — where several
  specs are **independent and ready at once** (forces parallelism) and others are
  **hard-blocked** (forces the walker + stacking).
- **A growing, hidden acceptance harness per milestone** — "done" is a green
  suite, and the harness doubles as the benchmark `accept` tier.
- **Planted deficiencies** — a missing index, an unhandled edge case — that, once
  the base merges, get **filed as real issues** → ingested → triaged → become
  specs → inserted/prioritized → executed. Closes the issue loop on real
  artifacts.
- **Shared-file pressure** — parallel specs that both touch the router/types/
  migrations, to force real conflicts → intent-preserving resolution.

### The proof checklist (what a single `apex` launch must demonstrate, autonomously)

1. Ideation (real LLM): brief → personas/behaviors/milestones + `.tanren/PROJECT.md`.
2. DAG derivation (real LLM): a sane, executable spec DAG with dependencies.
3. Autonomous DAG execution: walker picks ready specs, runs **N in parallel**,
   blocks dependents, advances milestone-by-milestone — **zero per-spec triggers.**
4. Merge coordination: parallel specs auto-rebase; conflicts resolved
   intent-preservingly; dependent specs stack; queue mode exercised.
5. Issue loop: planted deficiency → real issue → ingest → triage → spec →
   DAG-insert → prioritize → execute → merge.
6. Observability: budget ceiling enforced; live token usage per role; 4-source
   cost; **DORA accumulating across the milestone's merged runs.**
7. The finished product: empty repo → working, tested, (deployed) service, every
   change a merged PR with full provenance.

### Then benchmark

`apex` is exactly the workload Workstream B tunes against: once it runs to a
finished product, the benchmark toolkit (already built) varies one knob at a time
(planner decomposition, gate strictness, cheap-models-only, checker/auditor
strictness) across `apex` trials to pre-tune Tanren's defaults — measured, not
guessed.

## 5. PR-sized work breakdown + dependencies

```
Phase 1 (autonomy core)
  P1a  DagWalker contract + walker + conformance + worker-boot wiring   [keystone]
  P1b  specs.priority migration + thread through create/accept + walker order   → P1a
  P1c  wire real-LLM Forge answerers (interview/discovery/triage/recon/⌘K);
       deterministic answerers → test fixtures                         [parallel to P1a]
  P1d  ingestion scheduler (poll → real triage → autonomous spec insert)   → P1b, P1c

Phase 2 (merge coordination) — starts once P1a lands (collisions appear)
  P2a  MergeCoordinator contract + up-to-date/auto-rebase + conformance  → P1a
  P2b  intent-preserving conflict-resolution Answerer + re-gate          → P2a
  P2c  dynamic base targeting + stacked/chain PRs + auto-retarget        → P2a
  P2d  pluggable merge-queue seam (native default + Mergify adapter)     → P2a

Phase 3 (proof)
  P3a  apex fixture repo (brief + hidden accept tiers + planted issues)  → P1*, P2*
  P3b  apex live run + fix-what-stalls loop                              → P3a
  P3c  benchmark apex (knob experiments)                                 → P3b
```

Each is one CI-gated PR (some, like P2b and the walker, may be 2–3). The
sequence is honest about co-dependency: **P1a unblocks both the rest of Phase 1
and all of Phase 2.**

## 6. Open decisions (resolve as we reach them)

- **`apex` domain** — URL-shortener (clean, well-understood, naturally layered)
  vs. a domain mirroring the operator's real side project (lessons transfer
  maximally). Structural requirements are fixed either way.
- **`apex` scope** — API-only (cheaper; exercises every primitive except
  live-preview-deploy) vs. full product incl. dashboard UI + deploy.
- **Milestone-boundary gate** — does the walker pause at each milestone for an
  operator OK, or run fully unattended with budget as the only governor? (Likely
  configurable; default unattended-within-budget for the proof.)
- **Native queue depth** — how much of a real merge queue (batching, bisecting a
  failed batch) to build in P2d vs. lean on the external adapter initially.

## 7. Cost & sequencing reality

This is a **multi-session build** — larger than the entire Tempering effort. The
`apex` run itself spends real credits and real wall-clock (a full milestone of
real-LLM ideation + many parallel agent runs + conflict resolution). The payoff
is the only thing that actually proves the product: a clean repo becoming a
finished, tested product **with no human in the per-spec loop** — and the
workload the benchmark then tunes against. Build order is strictly Phase 1 →
Phase 2 → `apex`; nothing about `apex` is attemptable until the autonomy core
and the merge coordination it forces both exist.

## 8. Enforcement — "no stubs in production" + a real-resource e2e gate

The audit proved the danger is not _fakes_ (those were purged) but **deterministic
stand-ins and scaffolds that ship as the production default** (the Forge stub
answerers, `noopConflictResolver`, `NoopQuotaPolicy`, narration templates). These
are how a system silently becomes a shell. Two mechanical enforcements, built
**alongside Phase 1**, make "Tanren is real" a gate rather than a claim.

### 8a. Stubs/shells/mockups are test-fixtures-only — mechanically enforced

Principle (now a hard invariant): **a stub, shell, mock, deterministic
stand-in-for-an-LLM, templated-instead-of-reasoned generator, or no-op policy may
exist ONLY in `tests/` and may never be the value a production code path
constructs or defaults to.** This generalizes the existing no-fake-writer /
no-in-mem-secret-store rules to the whole repo.

Enforce it with a **custom architecture lint** (a new check in
`scripts/check-architecture.mjs`, the same gate that hosts `file-line-max-500`,
`single-event-writer`, etc.):

- Flag any production-source (`**/src/**`, not `tests/`) construction or
  default-assignment of an identifier matching the stub taxonomy —
  `createDeterministic*Answerer`, `*Stub`, `Noop*`/`*Noop`, `Fake*`, `Mock*`,
  `templated*` generators, and a curated allowlist-by-annotation for the few
  legitimate OSS↔SaaS seams (e.g. `NoopQuotaPolicy` is the _intended_ OSS
  default — those carry an explicit `// arch-allow: oss-seam <reason>` and are
  enumerated, so the allowlist itself is reviewable and finite).
- The default of an injectable seam in production must be the **real** impl (or a
  hard failure when unconfigured — `UnconfiguredAllocator`'s throw is the
  correct pattern), never a stand-in. A seam whose real impl exists but is
  unwired (today: every `wrapProvider*Answerer`) **fails the lint** until wired.
- Move the deterministic Forge answerers, `noopConflictResolver`, and the
  narration templates into `tests/fixtures/**` as Phase 1c/2b wire their real
  replacements; the lint then keeps them out of `src/`.

This converts the audit's findings into a **standing ratchet**: a future PR that
reintroduces a production stub fails CI.

### 8b. A real-resource, real-credential tagged e2e suite

The unit/integration suites pass with mocks — that is exactly why they did not
catch that the Forge front-end was templated. We need a suite that **cannot pass
unless Tanren actually works against real resources.**

- A new **`tagged e2e` gate** (`just e2e`, opt-in / nightly / pre-release — NOT
  on the per-PR fast path; it spends real credits and wall-clock) that runs the
  **real stack** (`up-dev`) with **real provider + GitHub credentials** and
  **forbids test fixtures / mock adapters entirely** (its own arch check: an e2e
  test that imports a `tests/fixtures/*` mock fails).
- It drives the **real operator flow against the real fixtures** — at minimum the
  three tier proofs (easy/medium/hard → merged PR) and, as each Phase-1/2/3
  capability lands, the autonomous slices: real-LLM ideation produces a real DAG;
  the walker drives a multi-spec DAG to merged PRs with no per-spec trigger; a
  real conflict is resolved intent-preservingly; a real issue ingests → triages →
  becomes a merged spec. `apex` (Phase 3) is the apex e2e case.
- Each e2e asserts on **real persisted artifacts** — a merged PR on GitHub, the
  implemented file on the base branch, `cost_records` rows with real basis, the
  DORA projection — not on a mocked return. The suite is the standing,
  machine-checkable answer to "is Tanren real or a stubbed shell?"
- Real-credential e2e never runs in the public PR CI (no secrets there, per the
  existing `just acceptance` discipline); it runs locally / in a credentialed
  nightly, and its result (run IDs + PR URLs) is the release evidence.

These two — the stub-ban lint (8a) and the real-resource e2e gate (8b) — are the
**guardrails** that keep the autonomy build (and everything after) honest:
8a stops a shell from forming in the source; 8b proves the assembled system does
real work end-to-end. Both are built **in Phase 1**, not deferred, because the
Forge real-LLM wiring (1c) is precisely the kind of change whose absence they
exist to catch.
