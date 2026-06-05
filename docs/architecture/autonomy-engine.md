# Autonomy Engine — design rationale

The durable design rationale behind Tanren's **autonomy engine**: the layer that
turns a product brief into a roadmap DAG that executes itself — specs triaged,
prioritized, run in parallel, merged with DAG-aware coordination, and fed by an
autonomous issue-ingestion loop, all under live budget / DORA / visibility.

This is an **architecture-rationale doc**, not a build plan. The autonomy engine
(Phases 1 and 2) is **built and merged** — see `ROADMAP.md` §2 for the phase
history and the merged surfaces. What lives here is the _why_: the principles,
the speculation-and-percolation model, the apex intent, and the guardrail
rationale that the in-code `§`-anchored comments cite. The section anchors below
(§1.x, §1a, §1b, §1d, §2b, §2c, §2d, §3 proof 6, §8a, §8b) are stable: ~a dozen
source comments reference them, so the anchored sections survive at this path.

## 1. Architectural principles

1. <a id="s11"></a>**§1.1 — The merge queue is a native, headline Tanren
   capability, not an external dependency.** Tanren owns the hard parts an
   external queue provides (DAG-aware ordering, speculative integration,
   intent-preserving conflict resolution) and the verification too — the
   **native gate** runs over SSH and is the merge authority (no GitHub Actions in
   the delivery path). The pluggable seam is the thin **VCS provider** (GitHub
   now; GitLab/others later) behind a `VcsProvider` contract —
   code/review/check-publication/merge-accept, _not_ delivery. Mergify is gone,
   not an optional adapter. This is the headline differentiator: intelligent
   velocity, provider-agnostic, Action-less.
2. **Conflict resolution is always native + intent-preserving.** A mechanical
   resolver (`git rerere`, or any text-only external tool) can only pick text.
   Tanren's resolver has the **acceptance criteria + intent of _both_ conflicting
   specs** and the DAG edge between them, so it resolves to satisfy **both
   intents** and re-runs the checker/auditor/gate against the merged result. No
   external tool can preserve spec intent — this is why the queue must be native.
3. <a id="s13"></a>**§1.3 — The only run gate is budget; there are no quotas.** A
   user's sole limit is the budget _they_ set (per-task / per-day / per-project /
   per-org dollar + window ceilings), enforced for everyone (OSS and managed
   alike). There is no plan-based admission/quota seam — it is the wrong
   abstraction (see §1.x billing). There is no `QuotaPolicy`; budget enforcement
   is the real, universal gate.
4. <a id="s14"></a>**§1.4 — Concurrency is a governed config knob, never an env
   var.** The per-project / per-org max concurrency lives in config (the
   routing/limits surface), and the `DagWalker` treats it as a _ceiling_ it
   throttles **below** in response to live `rate_limit_observations` and budget
   burn. Spend-rate is tunable without a redeploy and self-protects against rate
   limits / overspend.
5. <a id="s15"></a>**§1.5 — Everything is an event-driven reaction.** The autonomy
   layer reacts to the `run.*` / `merge.completed` events already on the
   `LISTEN/NOTIFY` bus — no new polling for internal state. A spec finishing fires
   the walker; a merge firing re-checks dependents' freshness. (External _intake_
   adds webhooks — §1d.)
6. **Contracts-as-durable-asset.** Each new capability is a seam with a
   conformance suite (like `Allocator` / `JobQueue` / `Repositories`), so the
   `VcsProvider` adapter (GitHub/GitLab), an optional external-queue adapter, and
   the eventual Rust rewrite all slot in.
7. <a id="s17"></a>**§1.7 — DAG state is the source of truth.** Priority,
   readiness, and stacking are derived from persisted spec/dependency rows under
   RLS — not held in memory. **Milestones are a human-readability grouping, not an
   execution gate**: the DAG progresses as aggressively as it is tuned/budgeted,
   never pausing at a milestone line.

### 1.x — Transparent, usage-based billing (why there are no quotas)

<a id="s1x"></a>The product/business model the architecture must serve (recorded
here so the seams match it; pricing specifics stay out of the repo as commercial
logic):

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
`providerMode: byok | managed` toggle; managed mode resolves the platform router
credential and attaches a transparent cost-record (real cost + the margin line)
per call; the **`metering-export`** seam (the clean READ seam a hosting layer
consumes to bill) is the billing substrate. The real, universal **budget** caps
are the only thing that ever stops a run.

## 1a. The DagWalker (the keystone)

<a id="s1a"></a>A background **`DagWalker`** per project turns the DAG into
self-driving execution. On startup and on every `run.*`-terminal /
`merge.completed` notification for the project, it:

1. Loads the project's spec DAG (specs + `dependsOn` edges + status + the
   speculative-readiness state, §2c).
2. Computes the **ready set** — specs whose dependencies have each crossed the
   configured **speculation threshold** (§2c; default: ancestor CI-green +
   audited with no P0/P1 findings — _not_ necessarily merged).
3. Orders the ready set by **priority** (§1b) then a deterministic tiebreak.
4. Enqueues up to the **governed concurrency headroom** (config ceiling,
   throttled below by live rate-limit/budget signals — §1.4) of ready specs via
   the existing `createQueuedRunFromSpec` path — the **same** parallel worker runs
   them, against the right base branch (§2c stacking).
5. Drives the DAG **as aggressively as tuned/budgeted** — it never pauses at a
   milestone line (milestones are labels). It stops only when the DAG is drained,
   budget is exhausted, or it is blocked awaiting human input it cannot route past.

It is a _scheduler over the existing executor_ (mirroring how `BenchmarkRunner`
schedules trials) — no second executor. It is idempotent (a spec already in-flight
is never re-enqueued) and emits `dag.spec.enqueued` / `dag.spec.speculative` /
`dag.drained` / `dag.budget.paused` events for visibility. The seam is
`engine/dag/walker.ts` + a `DagWalker` contract + conformance suite, wired into
worker boot as a long-lived per-project subscriber.

## 1b. Priority

<a id="s1b"></a>Specs carry a persisted `priority` (`P0 | P1 | P2 | tbd`) column,
threaded through `createSpec` and the discovery/triage acceptance path; the
`DagWalker` orders the ready set by it. This is what makes "prioritized around"
real instead of FIFO.

## 1d. Autonomous intake — webhook-first, poll-fallback

<a id="s1d"></a>Issue/signal intake runs **without an operator clicking
`ingest`**, in two modes per source:

- **Webhook receivers (push)** where the source supports them — GitHub issues /
  Sentry / Linear webhooks land on a receiver route. An event arrives → real-LLM
  triage → `auto_routable` candidates become specs **inserted into the DAG** with
  dependencies + priority; everything else lands in the candidate inbox for
  operator review (with the 1-click/chat affordance).
- **Polling (pull) fallback** for sources/configs without a webhook — a scheduled
  poller on a per-source interval.

Both honor rate limits + budget. This closes the issue-driven loop autonomously,
preferring real-time push over polling where the integration allows.

## 2. Native merge coordination

Once specs run in parallel, they go stale and collide. A `MergeCoordinator`
contract owns this; the run path's merge stage calls it instead of the bare
`directMerge`.

### 2b. DAG-aware, intent-preserving conflict resolution

<a id="s2b"></a>The differentiated capability. On a conflict between the merging
spec and what is now on the base:

1. Identify the conflicting spec(s) via the DAG + the conflicting files' recent
   provenance (which merged run last touched them).
2. Invoke a **conflict-resolution Answerer** given: the conflict hunks, **both
   specs' intent + acceptance criteria**, and the DAG edge. It produces a
   resolution that **preserves both intents** (or, if genuinely irreconcilable, a
   structured diagnosis that routes one spec back to the planner with the other's
   change as new context — intent stays alive, not dropped).
3. Apply, re-run the in-loop gate + checker/auditor against the resolved tree,
   then merge. The resolution is itself inspectable (events + the diff).

This is the principle made concrete: **the DAG knows the intent of every change,
so a conflict is a re-planning problem, not a text-picking problem.**

### 2c. Speculative execution + change-percolation (the full story)

<a id="s2c"></a>The goal: **let a deep DAG flow without serializing on every human
review**, while never building on genuinely-unstable foundations or silently
merging unreviewed work.

**Spec lifecycle states the walker reasons over:** `building → pr_open → ci_green
→ audited{P0..P3 findings} → review{auto|simulated|human, verdict} → merged`.
Speculation keys off these states, not just "merged".

**The speculation threshold** — when may a dependent start building before its
ancestor merges? Configurable per project; **default = Moderate**:

- **Conservative:** dependent starts only after the ancestor is **merged**. Safe,
  zero speculative rework, but human review serializes the whole DAG.
- **Moderate (default):** dependent starts once the ancestor is **CI-green +
  audited with no open P0/P1 findings** (P2/P3 findings are OK), **even if human
  review is still pending**. This routes _around_ the human-review bottleneck
  while staying off genuinely-unstable ancestors.
- **Aggressive:** dependent starts as soon as the ancestor's **PR is open**
  (pre-CI). Maximum parallelism, high invalidation risk.

**The mechanism — speculative integration branches.** When C is ready under the
threshold and depends on A (and/or B) that are unmerged:

1. The coordinator builds an **ephemeral integration branch** =
   `main + A.branch + B.branch` speculatively merged (in DAG order). If A and B
   conflict _with each other_, it surfaces **here, early**, on the integration
   branch — intent-preserving resolution (§2b) runs against it, not against poor C.
2. C's PR is **based on that integration branch** (dynamic base). C builds against
   the prospective merged world.
3. **At real merge time**, the merge queue (§2d) merges ancestors in DAG order;
   each ancestor merge triggers dependents to **auto-rebase onto the new `main`**
   — and because a _merged_ ancestor can differ from its _speculative_ form (a
   reviewer changed A), the rebase **re-runs C's gate + checker/auditor against
   reality**, not the speculation.

The hard case — C depends on A and B, both pending human review — is handled by
basing C on the `A+B` integration branch: we do **not** pre-merge A or B to
unblock C. They merge on their own real review timelines, through the queue, in
dependency order; C rebases after each. C's _work_ proceeds in parallel, but C's
_merge_ still waits until A and B are genuinely merged. No unreviewed code reaches
`main` early.

**Change-percolation — NOT discard.** When an ancestor changes after dependents
started speculatively (a P3 patch applies to A, a reviewer edits A, a new finding
lands), the walker must **NOT** throw away B's and C's work. It treats the
ancestor's change as a **delta to percolate down the chain**: the same
intent-preserving resolver as §2b — applied to an _intentional upstream change_
rather than a textual conflict — determines, for `A → B → C`, exactly **what in
A's change needs to flow into B**, applies it while **keeping B's work intact**,
re-gates B, then percolates B's resulting delta into C the same way. It is a chain
re-integration, not a rollback. The cheaper, faster, and more reliable this
percolation is, the **earlier B can safely start in A's journey** — percolation
quality is what makes an aggressive speculation threshold (and deeper speculative
stacks) economical. It is a first-class capability, co-designed with §2b/§2d, not
an error path.

Severity gates _whether_ percolation is needed promptly: a **P0/P1** finding or
**changes-requested** on A triggers immediate percolation; **P2/P3** changes
percolate lazily (batched into the next rebase). Nothing is ever silently merged
on stale work — but nothing is ever needlessly thrown away either.

### 2d. The native intelligent merge queue (headline capability)

<a id="s2d"></a>Per §1.1, the merge queue is **owned natively**, not delegated.
The `MergeCoordinator` runs an in-Tanren queue that:

- **Orders** ready-to-merge PRs in **DAG order** (ancestors before dependents), by
  priority within a layer.
- **Speculatively integrates + batch-checks** the prospective merged state (the
  `A+B+…` integration branch from §2c), so a bad _interaction_ is caught before it
  hits `main` — and **bisects a failed batch** to find the offending PR rather
  than blocking the whole batch.
- **Serializes conflict-prone merges** and invokes intent-preserving resolution
  (§2b) when a real conflict surfaces, then re-gates and merges.
- Is **provider-agnostic** via the `VcsProvider` seam — GitHub today;
  GitLab/others later. The queue logic is Tanren's; only the VCS calls are behind
  the adapter.

The native engine is strictly more capable than an external queue because it has
the DAG + spec intent that an external tool never sees. It absorbs what an
external queue would provide — merge queue + speculative checks (§2d), DAG-derived
stacks (§2c), auto-rebase (§2a), **flaky-test detection + auto-quarantine**, **CI
analytics / insights** (timing, pass-rate, slow steps — extending the existing
workflow-insights compute), and **queue statistics** (derived from the native
queue's own events). These are things Tanren _acts on_, not delegates.

## 3. apex — the proof

<a id="s3"></a>The capstone is `apex`: a max-difficulty fixture that forces every
capability above and proves the end-to-end claim — a clean repo becoming a
finished, tested, deployed product **with no human in the per-spec loop**.

> **Operating contract:** `docs/operator-guide/apex.md`. It is binding and
> counterintuitive: apex tests **Tanren**, not the fixture (a disposable URL
> shortener) and not efficiency (the target is "functional but weak", not a
> benchmark). The driver acts as a **non-technical end user over the real
> external surfaces only** (HTTP API + dashboard) — never hand-fixes the generated
> repo; files real **issues into Tanren** for every defect and watches the
> triage→spec→DAG→fix→merge loop close; adds a Tanren API endpoint rather than
> reaching inside when one is missing.

What apex ships is almost nothing — that is the point: **Tanren itself** must
build the brief, personas, behaviors, and the DAG through Forge conversation.

- **A single paragraph of rough operator notes** — _not_ a polished brief, _not_
  personas/behaviors/milestones. A core part of the evaluation is how well Tanren
  turns those high-level notes, through conversation, into real actionable
  personas / behaviors / milestones / a DAG.
- **An empty (or near-empty) target repo** — Tanren writes everything.
- **A hidden, growing acceptance harness** (the only "answer key") — used as the
  benchmark `accept` tier; never shown to the building agents.
- **Planted deficiencies** that surface only after the base works — to be filed as
  real issues that drive the ingestion → triage → spec → DAG-insert loop on real
  artifacts.

**The domain — a URL shortener _with a real external integration_** (a Slack bot)
**and a deployed web UI.** The external integration is deliberate: it forces an
external API client, secret handling for the Slack token, outbound calls, a
behavior that cannot be unit-tested in isolation. The web UI + deploy exercises
the **live-preview-deploy** surface and a full product slice. Structurally it
yields the needed shape: layered hard-blocked dependencies (model → storage →
shorten/redirect → API → analytics → the Slack integration → the web UI) **and**
independent-ready-at-once specs (rate-limit ∥ analytics) that force parallelism,
plus shared-file pressure (router/types/migrations) that forces real conflicts.

### §3 proof 6 — observability + budget

<a id="proof6"></a>A single `apex` launch must demonstrate, autonomously: ideation
from rough notes (real LLM); DAG derivation; autonomous DAG execution (N in
parallel, governed concurrency, speculative unblock, no milestone pauses, zero
per-spec triggers); merge coordination (auto-rebase, intent-preserving conflict
resolution, stacked dependents, the native queue); the issue loop (planted
deficiency → real issue → triage → spec → DAG-insert → execute → merge); and
**observability** — the **budget ceiling enforced** (run pauses on exhaustion via
`dag.budget.paused`), live token usage per role, 4-source cost incl. the
managed-mode transparent margin line, and **DORA accumulating across the many
merged runs**. The finished product is a working, tested, deployed URL shortener
with a web UI and a live Slack integration — every change a merged PR with full
provenance, driven entirely over real external surfaces.

`apex` is then exactly the workload the benchmark tunes against: the toolkit
varies one knob at a time (planner decomposition, gate strictness,
cheap-models-only, checker/auditor strictness) across `apex` trials to pre-tune
Tanren's defaults — measured, not guessed.

## 8. Guardrails — "no stubs in production" + a real-resource e2e gate

The danger is not _fakes_ but **deterministic stand-ins and scaffolds that ship as
the production default** — these are how a system silently becomes a shell. Two
mechanical enforcements make "Tanren is real" a gate rather than a claim.

### 8a. Stubs/shells/mocks are test-fixtures-only — mechanically enforced

<a id="s8a"></a>Principle (a hard invariant): **a stub, shell, mock, deterministic
stand-in-for-an-LLM, templated-instead-of-reasoned generator, or no-op policy may
exist ONLY in `tests/` and may never be the value a production code path
constructs or defaults to.**

Enforced by the `no-production-stubs` architecture lint in
`scripts/check-architecture.mjs`:

- Flag any production-source construction or default-assignment of an identifier
  matching the stub taxonomy (`createDeterministic*Answerer`, `*Stub`,
  `Noop*`/`*Noop`, `Fake*`, `Mock*`, `templated*` generators).
- The default of an injectable seam in production must be the **real** impl — or a
  **hard failure** when unconfigured (`UnconfiguredAllocator`'s throw, or
  `UnconfiguredVcsProvider`). A seam whose real impl exists but is unwired fails
  the lint until wired.
- A small, **annotated, enumerated allowlist** covers the genuinely-correct
  "absence is the right behavior" cases. It now holds exactly one entry —
  `StubChannel`, the unconfigured-notification-channel record that writes
  `stubbed` rather than silently dropping (absence-is-honest, not a stand-in).
  Each carries an explicit `// arch-allow: <reason>` and is finite + reviewable.

This is a **standing ratchet**: a future PR that reintroduces a production stub
fails CI.

### 8b. A real-resource, real-credential tagged e2e gate

<a id="s8b"></a>The unit/integration suites pass with mocks — that is exactly why
they did not catch a templated front-end. The `just e2e` gate (opt-in / nightly /
pre-release — NOT on the per-PR fast path; it spends real credits) runs the
**real stack** with **real provider + GitHub credentials** and **forbids test
fixtures / mock adapters entirely** (its own arch check: an e2e test importing a
`tests/fixtures/*` mock fails). It drives the real operator flow against real
fixtures and **asserts on real persisted artifacts** — a merged PR on GitHub, the
implemented file on the base branch, `cost_records` rows with real basis, the DORA
projection — never on a mocked return. `apex` is the apex e2e case. The suite is
the standing, machine-checkable answer to "is Tanren real or a stubbed shell?"
