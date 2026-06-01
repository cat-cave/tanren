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
slots, `engine/worker/runWorker.ts`), real cost/token accounting, real workflow
insights, and the de-privileged plane split.

What is **not** real / not autonomous:

| Capability                                      | Status today                                                                                                                                                                                                                   | Severity |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| **DAG-walker** (auto-select & enqueue specs)    | NOT BUILT — execution is pure pull; an operator calls `POST …/specs/:id/runs` per spec. Deps only gate-at-trigger (`projectSpec.ts` `ensureSpecDependenciesDone`).                                                             | CRITICAL |
| **Real-LLM Forge** (interview/discovery/triage) | STUB-ONLY in prod — all default to `createDeterministic*Answerer`; the real `wrapProvider*Answerer` exist but are **never injected** (`mountFeatureRoutes` passes no `answererFactory`).                                       | CRITICAL |
| **Discovery proposals**                         | Hardcoded templates ("add csv export", "fix session race"). No LLM decides _what to build_.                                                                                                                                    | CRITICAL |
| **Issue ingestion**                             | Manual `POST …/inbox/sources/:id/ingest` only. No scheduled poller. Audit scheduler isn't on a loop.                                                                                                                           | CRITICAL |
| **Priority**                                    | A discovery-output field that is **never persisted on the spec and nothing reads** to order execution.                                                                                                                         | HIGH     |
| **Concurrency control**                         | Worker reads `TANREN_RUN_WORKER_CONCURRENCY` from the **env** (`lifecycle.ts`), not config — a redeploy to change a spend-rate knob. (Note: `AllocatorConfig.concurrency` already exists in config but the worker ignores it.) | HIGH     |
| **Quota/admission seam**                        | `NoopQuotaPolicy` is the production default (`runExecutor.ts`); a `QuotaPolicy` admission seam exists but is the **wrong abstraction** — see §1 (budget, not quotas).                                                          | (delete) |
| **Auto-rebase / up-to-date before merge**       | NOT BUILT — `directMerge` calls merge once; a stale branch surfaces as a 405/409 conflict.                                                                                                                                     | HIGH     |
| **Conflict resolution**                         | Hook scaffolded (`mergeDispatch.ts` `resolveConflict?`), default is `noopConflictResolver`. No resolver.                                                                                                                       | HIGH     |
| **Stacked / chain PRs + dynamic base**          | NOT BUILT — every PR targets `projects.default_branch` (`githubDraftPr.ts`).                                                                                                                                                   | HIGH     |
| **Merge queue**                                 | PARTIAL — `mergify_queue` applies a label and hands off to an external Mergify app; Tanren manages nothing.                                                                                                                    | MEDIUM   |
| **Forge ⌘K / narration**                        | Templated v0 (`forge/narration/v0.ts`); real Answerer exists but unwired.                                                                                                                                                      | MEDIUM   |

The co-dependency that drives sequencing: **the moment the DAG-walker turns on,
parallel specs on a young repo collide constantly** — so auto-rebase and
conflict resolution are not optional Phase-2 polish, they are the immediate
consequence of Phase 1 working.

## 1. Architectural principles

1. **The merge queue is a native, headline Tanren capability — not an external
   dependency.** We are already building the hard parts an external queue
   provides (DAG-aware ordering, speculative integration, intent-preserving
   conflict resolution); the small remaining delta makes it a full **intelligent
   merge queue for any VCS + actions provider**. The pluggable seam is therefore
   the **VCS/actions provider** (GitHub Actions now; GitLab/others later), behind
   a `VcsProvider` contract — _not_ the queue. An external queue (Mergify) drops
   to an _optional_ adapter, rarely needed. This is the headline differentiator:
   intelligent velocity, provider-agnostic.
2. **Conflict resolution is always native + intent-preserving.** A mechanical
   resolver (Mergify, `git rerere`) can only pick text. Tanren's resolver has
   the **acceptance criteria + intent of _both_ conflicting specs** and the DAG
   edge between them, so it resolves to satisfy **both intents** and re-runs the
   checker/auditor/gate against the merged result. No external tool can preserve
   spec intent — this is why the queue must be native.
3. **The only run gate is budget — there are no quotas.** A user's sole limit is
   the budget _they_ set (per-task / per-day / per-project / per-org dollar +
   window ceilings), enforced for everyone (OSS and managed alike). There is no
   plan-based admission/quota seam — it is the wrong abstraction (see §1.x
   billing). The existing `QuotaPolicy` / `NoopQuotaPolicy` is deleted; budget
   enforcement is the real, universal gate.
4. **Concurrency is a governed config knob, never an env var.** The per-project /
   per-org max concurrency lives in config (the routing/limits surface), and the
   `DagWalker` treats it as a _ceiling_ it throttles **below** in response to live
   `rate_limit_observations` and budget burn. Spend-rate is tunable without a
   redeploy and self-protects against rate limits / overspend.
5. **Everything is an event-driven reaction.** The autonomy layer reacts to the
   `run.*` / `merge.completed` events already on the `LISTEN/NOTIFY` bus — no new
   polling for internal state. A spec finishing fires the walker; a merge firing
   re-checks dependents' freshness. (External _intake_ adds webhooks — §1d.)
6. **Contracts-as-durable-asset.** Each new capability is a seam with a
   conformance suite (like `Allocator`/`JobQueue`/`Repositories`), so the
   `VcsProvider` adapter (GitHub/GitLab), the optional external-queue adapter, and
   the Rust rewrite all slot in.
7. **DAG state is the source of truth.** Priority, readiness, and stacking are
   derived from persisted spec/dependency rows under RLS — not held in memory.
   **Milestones are a human-readability grouping, not an execution gate**: the DAG
   progresses as aggressively as it is tuned/budgeted, never pausing at a
   milestone line.

### 1.x — Transparent, usage-based billing (why there are no quotas)

The product/business model the architecture must serve (recorded here so the
seams match it; pricing specifics stay out of the repo as commercial logic):

- **Self-hosted / OSS:** you own your compute and credits; there is nothing to
  meter against a plan. Your only governor is the budget you set. No admission
  policy, no quotas.
- **Managed — BYOK:** your keys, your compute; Tanren-managed runs the
  orchestration. It's your key — you do you. No usage limit beyond your budgets.
- **Managed — metered:** Tanren provides the router/keys/compute and bills
  **transparent usage-based — our cost + a fixed, disclosed margin** (e.g.
  cost + ~10%). Your billing transparency _is_ our cost transparency. The trust
  play is exactly this: an org weighs "self-host vs. pay a small margin to not
  worry about it" as a clean economic decision, because nothing is hidden. This
  holds even long-term (e.g. self-served models on rented GPUs stay usage-based).

Architecturally this means: **no `QuotaPolicy`.** The managed/BYOK split is the
existing `providerMode: byok | managed` toggle; managed mode resolves the
platform router credential and attaches a transparent cost-record (real cost +
the margin line) per call; the existing **`metering-export`** seam (already "the
clean READ seam a hosting layer consumes to bill") is the billing substrate. The
real, universal **budget** caps are the only thing that ever stops a run. This is
also a §8a win: deleting `NoopQuotaPolicy` removes a production no-op instead of
allowlisting it.

## 2. Phase 1 — the autonomy core (makes the DAG real)

### 1·0. Budget-is-the-gate + concurrency-is-config (cleanup, lands first)

A focused PR, early in Phase 1, that **deletes the `QuotaPolicy` admission seam**
(`engine/quota/{contracts,noopPolicy,dbPolicy}.ts`, the `runExecutor`
`checkAdmission` call) and makes **budget enforcement** the universal run gate;
and moves worker **concurrency from the env** (`TANREN_RUN_WORKER_CONCURRENCY`)
into the per-project/org config surface the `DagWalker` reads. This lands before
1a so the walker's run-gating is budget-only and config-driven from day one. It
keeps the `metering-export` seam (billing substrate) and `providerMode` toggle.
It is also the first §8a stub removal (a production no-op deleted, not
allowlisted).

### 1a. The DAG-walker (the keystone)

A background **`DagWalker`** per project that turns the DAG into self-driving
execution. On startup and on every `run.*`-terminal / `merge.completed`
notification for the project, it:

1. Loads the project's spec DAG (specs + `dependsOn` edges + status + the
   speculative-readiness state, §2c).
2. Computes the **ready set** — specs `pending` whose dependencies have each
   crossed the configured **speculation threshold** (§2c; default: ancestor
   CI-green + audited with no P0/P1 findings — _not_ necessarily merged).
3. Orders the ready set by **priority** (1b) then a deterministic tiebreak.
4. Enqueues up to the **governed concurrency headroom** (config ceiling, throttled
   below by live rate-limit/budget signals — §1.4) of ready specs via the
   existing `createQueuedRunFromSpec` path — the **same** parallel worker runs
   them, against the right base branch (§2c stacking).
5. Drives the DAG **as aggressively as tuned/budgeted** — it never pauses at a
   milestone line (milestones are labels). It stops only when the DAG is drained,
   budget is exhausted, or it's blocked awaiting human input it cannot route past.

It is a _scheduler over the existing executor_, mirroring how `BenchmarkRunner`
already schedules trials — no second executor. Idempotent (a spec already
in-flight is never re-enqueued), and emits `dag.spec.enqueued` /
`dag.spec.speculative` / `dag.drained` / `dag.budget.paused` events for
visibility. **Milestones** drive grouping/DORA/visibility, not gating.

**Seam:** `engine/dag/walker.ts` + a `DagWalker` contract + conformance suite.
Wired into the worker boot as a long-lived per-project subscriber.

### 1b. Persist + honor priority

Add a `priority` (`P0|P1|P2|tbd`) column to `specs` (migration), thread it
through `createSpec` and the discovery/triage acceptance path (it already exists
on `ProposedSpec`), and have the `DagWalker` order the ready set by it. This is
what makes "prioritized around" real instead of FIFO.

### 1c. Wire real-LLM Forge — options AND conversation

Inject the existing `wrapProviderInterviewAnswerer` / `wrapProviderDiscoveryAnswerer`
/ provider triage answerer (and the brownfield recon + Forge-conversation
provider answerers) into their routes via the `answererFactory` the routes
already accept, resolved from the project's routing table (the same role-routing
the run loop uses; default Codex/Claude). The deterministic answerers **move to
test fixtures** (per §8a) — production ideation must reason with a model.

**Every Forge surface is dual-mode: structured options _and_ free-text chat.**
The model returns **1-click options** (proposed specs, triage verdicts, placement
choices) so the common case is a single click — _and_ free text is always
accepted, so the operator can say what they actually want and the model
re-proposes. "LLM generates options for 1-click where obvious; conversation is
always available" is the interaction contract for discovery, triage, and ⌘K — not
a menu _or_ a chatbot, but both. This turns interview → personas/behaviors/
milestones, discovery → a real derived DAG, and triage → real candidate judgment
into live LLM behavior with a fast path.

> A real LLM may produce an invalid plan; the schema-validated Answerer contract
> already rejects non-conforming output. Where a deterministic _grounding_ step
> is genuinely valuable (e.g. read-tools feeding the LLM context), keep it as a
> pre-step that feeds the model, not as the answer itself.

### 1d. Autonomous intake — webhook-first, poll-fallback

Issue/signal intake runs **without an operator clicking `ingest`**, in two modes
per source:

- **Webhook receivers (push)** where the source supports them — GitHub (issues /
  Sentry / Linear webhooks land on a receiver route; the repo already has a
  `routes/githubWebhooks/` surface to extend). An event arrives → real-LLM triage
  → `auto_routable` candidates become specs **inserted into the DAG** with
  dependencies + priority; everything else lands in the candidate inbox for
  operator review (with the 1-click/chat affordance from 1c).
- **Polling (pull) fallback** for sources/configs without a webhook — a scheduled
  poller (generalizing `forge/audits/scheduler.ts`) on a per-source interval.

Both honor rate limits + budget. This closes the issue-driven loop autonomously,
preferring real-time push over polling where the integration allows.

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

### 2c. Speculative execution — stacked / chain PRs + dynamic base (the full story)

"Stacked PRs with dynamic base targeting" can mean many things; this is the
precise mechanism, the readiness model, and the edge cases. The goal: **let a deep
DAG flow without serializing on every human review**, while never building on
genuinely-unstable foundations or silently merging unreviewed work.

**Spec lifecycle states the walker reasons over** (beyond `pending`/`done`):
`building → pr_open → ci_green → audited{P0..P3 findings} → review{auto|simulated|
human, verdict} → merged`. Speculation keys off these states, not just
"merged".

**The speculation threshold** — when may a dependent start building before its
ancestor merges? Configurable per project; **default = Moderate**:

- **Conservative:** dependent starts only after the ancestor is **merged**. Safe,
  zero speculative rework, but human review serializes the whole DAG — the
  velocity problem this feature exists to solve.
- **Moderate (default):** dependent starts once the ancestor is **CI-green +
  audited with no open P0/P1 findings** (P2/P3 findings are OK), **even if human
  review is still pending**. This is the sweet spot: it routes _around_ the
  human-review bottleneck while staying off genuinely-unstable ancestors. An
  ancestor that is "technically complete but pending automated audits" is **not**
  ready (audits gate); an ancestor with only P2/P3 findings **is** ready (those
  are non-blocking polish).
- **Aggressive:** dependent starts as soon as the ancestor's **PR is open**
  (pre-CI). Maximum parallelism, high invalidation risk.

**The mechanism — speculative integration branches.** When C is ready under the
threshold and depends on A (and/or B) that are unmerged:

1. The coordinator builds an **ephemeral integration branch** =
   `main + A.branch + B.branch` speculatively merged (in DAG order). If A and B
   conflict _with each other_, it surfaces **here, early**, on the integration
   branch — intent-preserving resolution (2b) runs against it, not against poor C.
2. C's PR is **based on that integration branch** (dynamic base; today hardcoded
   to `projects.default_branch`). C builds against the prospective merged world.
3. **At real merge time**, the merge queue (2d) merges ancestors in DAG order;
   each ancestor merge triggers dependents to **auto-rebase onto the new `main`**
   (2a) — and because a _merged_ ancestor can differ from its _speculative_ form
   (a reviewer changed A), the rebase **re-runs C's gate + checker/auditor against
   reality**, not the speculation.

**The C-depends-on-A-and-B, both pending-human-review case** (the hard one): C
builds against the `A+B` integration branch. We do **not** pre-merge A or B to
unblock C — they merge on their own real review timelines, through the queue, in
dependency order; C rebases after each. So C's _work_ proceeds in parallel, but
C's _merge_ still waits until A and B are genuinely merged (no unreviewed code
reaches `main` early). The queue + speculative CI ensure the eventual A→B→C merge
sequence is pre-validated (speculative checks on the prospective merged state)
rather than discovered-broken at merge.

**Change-percolation — NOT discard.** When an ancestor changes after dependents
started speculatively (a P3 patch applies to A, a reviewer edits A, a new finding
lands), the walker must **NOT** throw away B's and C's work. It treats the
ancestor's change as a **delta to percolate down the chain**: an agent (the same
intent-preserving resolver as 2b, applied to an _intentional upstream change_
rather than a textual conflict) determines, for `A → B → C`, exactly **what in
A's change needs to flow into B**, applies it while **keeping B's work intact**,
re-gates B, then percolates B's resulting delta into C the same way. It is a
chain re-integration, not a rollback. The cheaper, faster, and more reliable this
percolation is, the **earlier B can safely start in A's journey** — percolation
quality is what makes an aggressive speculation threshold (and deeper speculative
stacks) economical. So this is a first-class capability, co-designed with 2b/2d,
not an error path: how well Tanren percolates upstream changes through a live DAG
is one of its core differentiators.

Severity still gates _whether_ percolation is even needed promptly: a **P0/P1**
finding or **changes-requested** on A triggers immediate percolation (the chain
must absorb it before merging); **P2/P3** changes percolate lazily (batched into
the next rebase) since they don't block. Nothing is ever silently merged on stale
work — but nothing is ever needlessly thrown away either.

**Net:** the threshold turns "wait for merge" into "wait for stable-enough,"
speculative integration branches make conflicts surface early and cheaply, the
queue keeps `main` always-valid, and **change-percolation keeps the chain's work
alive while absorbing upstream change** — making earlier speculation safe.

### 2d. The native intelligent merge queue (headline capability)

Per §1.1, the merge queue is **owned natively**, not delegated. The
`MergeCoordinator` runs an in-Tanren queue that:

- **Orders** ready-to-merge PRs in **DAG order** (ancestors before dependents),
  by priority within a layer.
- **Speculatively integrates + batch-checks** the prospective merged state (the
  `A+B+…` integration branch from 2c), so a bad _interaction_ is caught before it
  hits `main` — and **bisects a failed batch** to find the offending PR rather
  than blocking the whole batch.
- **Serializes conflict-prone merges** and invokes intent-preserving resolution
  (2b) when a real conflict surfaces, then re-gates and merges.
- Is **provider-agnostic** via the `VcsProvider` seam — GitHub (PR + Actions +
  merge API) today; GitLab/others later. The queue logic is Tanren's; only the
  VCS/CI calls are behind the adapter. This is the "intelligent velocity for any
  VCS + actions provider" headline.

**Reaching Mergify parity → removing it entirely.** The goal is not "Tanren + an
optional Mergify adapter" but **Tanren replacing Mergify**, because the things
Mergify provides are things Tanren wants to _act on_, not just delegate. The
parity checklist (we're ~80% there once 2a–2d land):

- merge queue + speculative checks → **2d** (native).
- stacks / stack diffs for review efficiency → **2c** (native, DAG-derived).
- auto-rebase / branch-up-to-date → **2a** (native).
- **test quarantine + flaky-test detection** → a `ci.flaky` / quarantine surface:
  Tanren already records per-run attempt/retry signals (`retry_hotspot`) — extend
  to detect flaky tests across runs and auto-quarantine them (with an event so the
  operator sees it), exactly the kind of thing Tanren _should_ act on.
- **CI analytics / insights (timing, pass-rate, slow steps)** → extends the
  existing workflow-insights compute (already real: retry_hotspot / review_stall /
  pace_anomaly) + the benchmark's DORA — surfaced per project.
- **queue / stack statistics** → derived from the native queue's own events.

Once that checklist is green, **Mergify is removed** (no adapter, no dependency) —
the native engine is strictly more capable because it has the DAG + spec intent
that an external tool never sees. (A `VcsProvider` adapter for a _different
external queue_ remains possible, but is not a goal.) The flaky-detection +
CI-analytics items are tracked as P2e (below); they are not blockers for the apex
proof but complete the "remove Mergify" story.

## 4. Phase 3 — `apex` fixture + run + benchmark

### The fixture — what `apex` ships is almost nothing

The point of apex is to prove **Tanren itself** builds the product brief,
personas, behaviors, and the DAG **in-house through Forge conversation** — so the
fixture must **not** arrive with those already written. What `apex` ships:

- **A single paragraph of rough, high-level operator notes** — _not_ a polished
  brief, _not_ personas/behaviors/milestones. Just "I want a URL shortener with
  per-link analytics, a small web UI to create/manage links, and a Slack bot that
  posts a summary when a link crosses N clicks." A core part of the evaluation is
  **how well Tanren turns those high-level notes, through conversation, into real
  actionable personas / behaviors / milestones / a DAG.**
- **An empty (or near-empty) target repo** — Tanren writes everything.
- **A hidden, growing acceptance harness** (the only "answer key") — used as the
  benchmark `accept` tier; never shown to the building agents.
- **Planted deficiencies** that surface only after the base works — a missing
  index, an unhandled edge — to be **filed as real issues** that drive the
  ingestion → triage → spec → DAG-insert loop on real artifacts.

**The domain — a URL shortener _with a real external integration_** (a Slack bot)
**and a deployed web UI.** The external integration is deliberate: it forces
Tanren to build something **real and outward-facing** — an external API client,
secret handling for the Slack token, outbound calls, a behavior that can't be
unit-tested in isolation. The **web UI + deploy** is also deliberate: it exercises
the **live-preview-deploy** surface (the run-detail/review preview pane that
nothing has driven yet) and a full product slice, not just an API. Structurally it
yields the needed shape: layered hard-blocked dependencies (model → storage →
shorten/redirect → API → analytics → the Slack integration that depends on the
analytics event → the web UI that depends on the API) **and**
independent-ready-at-once specs (rate-limit ∥ analytics) that force parallelism,
plus shared-file pressure (router/types/migrations) that forces real conflicts.

### The operator interacts only as a real user would

The apex driver is **forbidden from touching internal seams** — it acts exactly
like a real operator, over the **real external surfaces only**: the HTTP API and
the dashboard UI (via Playwright). (MCP is a tracked follow-up — see §6 — added to
apex once the HTTP MCP server exists; not an apex prerequisite.) This is enforced
by the §8b real-resource e2e gate: an apex test importing an internal mock or
calling a non-public seam fails. "Tanren is real" means a real user, over real
surfaces, gets a real product.

### The proof checklist (what a single `apex` launch must demonstrate, autonomously)

1. **Ideation from rough notes (real LLM):** high-level operator notes →, through
   Forge conversation (options + chat), real personas / behaviors / milestones +
   `.tanren/PROJECT.md`. _Tanren authored the brief, not the fixture._
2. **DAG derivation (real LLM):** a sane, executable spec DAG with dependencies +
   priorities.
3. **Autonomous DAG execution:** the walker picks ready specs, runs **N in
   parallel** (governed concurrency), speculatively unblocks dependents at the
   threshold, drives aggressively (no milestone pauses) — **zero per-spec
   triggers.**
4. **Merge coordination:** parallel specs auto-rebase; real conflicts resolved
   **with intent preserved**; dependents **stack** on speculative integration
   branches; the **native merge queue** orders + speculatively checks + merges.
5. **Issue loop:** planted deficiency → **real issue** (webhook-ingested) →
   triage → spec → DAG-insert → prioritize → execute → merge.
6. **Observability:** budget ceiling enforced (run pauses on exhaustion); live
   token usage per role; 4-source cost incl. (managed-mode) the transparent
   margin line; **DORA accumulating across the many merged runs.**
7. **The finished product:** near-empty repo → a working, tested, **deployed** URL
   shortener with a **web UI** for creating/managing links and a **live Slack
   integration** — exercising the **live-preview-deploy** surface (the
   run-detail/review preview pane) — every change a merged PR with full
   provenance, driven entirely over real external surfaces.

### Then benchmark

`apex` is exactly the workload Workstream B tunes against: once it runs to a
finished product, the benchmark toolkit (already built) varies one knob at a time
(planner decomposition, gate strictness, cheap-models-only, checker/auditor
strictness) across `apex` trials to pre-tune Tanren's defaults — measured, not
guessed.

## 5. PR-sized work breakdown + dependencies

```
Phase 1 (autonomy core)
  P1·0 budget-is-the-gate (delete QuotaPolicy/Noop) + concurrency→config   [lands first; §8a stub removal]
  P1a  DagWalker contract + walker + conformance + worker-boot wiring      [keystone]   → P1·0
  P1b  specs.priority migration + thread through create/accept + walker order   → P1a
  P1c  wire real-LLM Forge answerers (interview/discovery/triage/recon/⌘K),
       dual-mode options+chat; deterministic answerers → test fixtures    [parallel to P1a]
  P1d  autonomous intake: webhook receivers (push) + poll fallback → real triage → DAG insert   → P1b, P1c

  P8a  stub-ban architecture lint (check-architecture) + purge prod stubs  [parallel; pairs with P1·0/P1c]
  P8b  real-resource `just e2e` gate (no-mock arch check + tier proofs)    [parallel; grows per capability]

Phase 2 (merge coordination — native) — starts once P1a lands (collisions appear)
  P2·0 VcsProvider contract (GitHub adapter extracted) + conformance       → P1a
  P2a  up-to-date/auto-rebase (re-gate on rebase)                          → P2·0
  P2b  intent-preserving conflict-resolution Answerer + re-gate            → P2a
  P2c  speculative execution: spec lifecycle + threshold + integration branches
       + dynamic base + CHANGE-PERCOLATION (chain re-integration, not discard)   → P2a, P2b
  P2d  native intelligent merge queue (DAG-order, speculative batch-check, bisect)   → P2b, P2c
  P2e  Mergify-parity CI intelligence: flaky-test detection + auto-quarantine,
       CI analytics/insights, queue/stack stats → then REMOVE Mergify       → P2d

Phase 3 (proof)
  P3a  apex fixture (rough operator notes + empty repo + hidden accept tiers + planted issues + Slack + web UI)   → P1*, P2*
  P3b  apex live run over real surfaces (API + Playwright UI) + live-preview-deploy + fix-what-stalls   → P3a
  P3c  benchmark apex (knob experiments)                                   → P3b
```

Each is one CI-gated PR (the walker, P2b, P2c, P2d may each be 2–3). Co-dependency
is honest: **P1·0 → P1a unblocks the rest of Phase 1 _and_ all of Phase 2**; §8a/8b
run alongside Phase 1 because the Forge real-LLM wiring (1c) is exactly the class
of change they exist to catch.

## 6. Open decisions

**Resolved (this review):**

- **Speculation threshold default → Moderate** (ancestor CI-green + audited, no
  open P0/P1; human-review-pending does **not** block dependents). §2c.
- **Merge queue → fully native, headline capability;** the pluggable seam is the
  `VcsProvider` (GitHub now, GitLab later), not the queue; external Mergify is an
  optional adapter. §1.1, §2d.
- **No milestone-boundary gate** — milestones are human-readability grouping; the
  DAG runs as aggressively as tuned/budgeted. §1.7, §1a.
- **No quotas** — budget is the only run gate; managed/BYOK billing is transparent
  usage-based via `providerMode` + `metering-export`. §1.3, §1.x.
- **apex domain → URL shortener + a real external (Slack) integration.** §3.
- **apex scope → full product: API + Slack integration + a web UI for creating/
  managing URLs**, so the run exercises the **live-preview-deploy** surface (the
  run-detail/review preview pane that nothing has driven yet). §3.
- **apex operator surfaces → real API + dashboard UI (Playwright) now; HTTP MCP
  is a tracked follow-up** added to apex once built (PROJECT_BRIEF §6.6 defers MCP
  to v1; building the HTTP MCP server is its own effort, not an apex blocker). §3.

**Still open (decide as we reach them):**

- **Speculative-integration depth** — how many unmerged ancestors deep to
  speculatively integrate before the rework risk outweighs the velocity (a tuned
  cap, surfaced when P2c is built); bounded by change-percolation quality (§2c).
- **HTTP MCP server** — when to build it (it unlocks the third apex surface and is
  a v1 product goal regardless).

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
answerers, `noopConflictResolver`, narration templates — and `NoopQuotaPolicy`,
which §1.x deletes outright). These are how a system silently becomes a shell. Two
mechanical enforcements, built **alongside Phase 1**, make "Tanren is real" a gate
rather than a claim.

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
  `templated*` generators. A small, **annotated, enumerated allowlist** covers the
  genuinely-correct "absence is the right behavior" cases — a seam whose
  unconfigured default is a **hard throw** (`UnconfiguredAllocator`) or an honest
  **"not wired" audit record** (`StubChannel` for an unconfigured notification
  channel, which records `stubbed` rather than silently dropping). These carry an
  explicit `// arch-allow: <reason>` and are finite + reviewable. (Note: the OSS
  quota no-op is **not** on this list — §1.x deletes it; budget enforcement is the
  real universal gate, so there is no no-op policy to allow.)
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
  real conflict is resolved with intent preserved; a real issue ingests → triages →
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
