# Autonomy Engine — design rationale

The durable design rationale behind Tanren's **autonomy engine**: the layer that
turns a product brief into a roadmap DAG that executes itself — specs triaged,
prioritized, run in parallel, merged with DAG-aware coordination, and fed by an
autonomous issue-ingestion loop, all under live budget / DORA / visibility.

This is an **architecture-rationale doc**, not a build plan. The autonomy engine
(Phases 1 and 2) is **built and merged** — see `ROADMAP.md` §2 for the phase
history and the merged surfaces. What lives here is the _why_: the principles,
the merge-coordination model, the apex intent, and the guardrail rationale that
the in-code `§`-anchored comments cite. The section anchors below (§1.x, §1a,
§1b, §1d, §2b, §2c, §2d, §3 proof 6, §8a, §8b) are stable: ~a dozen source
comments reference them, so the anchored sections survive at this path.

> **The tanren-owns-the-engine cutover (merged, flag-on, merge paths still
> apex-unproven).** The merge coordination described in §2 was originally built on a
> `VcsProvider`-shaped, speculative-integration-plus-change-percolation model.
> That model has since been **superseded and the cutover merged**: a jj (jujutsu)
> `WorkspaceVcsCore` is the VCS core, a guaranteed fail-closed **`MergeAuthority`**
> is the sole merge decision, a **never-discard** `BaseShiftCoordinator` rebases
> dependent work in place (the old "supersede + regenerate" percolation that _did_
> discard and re-plan work is replaced — not preserved), and the auditor emits
> **P0–P3 findings** gated by an **`auditPosture`** DORA knob. These live paths are
> **default-on behind kill-switch env vars** (`MERGE_AUTHORITY_LIVE`,
> `CONFLICT_RESOLVER_JJ_LIVE`, `BASE_SHIFT_LIVE`, `INTEGRATION_NODES_DRIVE`) and
> are **still apex-unproven for the merge path** — apex v32 ran live but halted at
> scaffold-bootstrap before reaching a merge, so the jj-against-a-runner merge path
> has not yet been exercised end-to-end; the flags are the kill-switches. §2b/§2c below
> are rewritten to the never-discard reality; the full rationale, the unified
> `integration_nodes` run model, and the deferred post-apex deletions are in
> `docs/architecture/tanren-owns-the-engine.md`.

## 1. Architectural principles

1. <a id="s11"></a>**§1.1 — The merge queue is a native, headline Tanren
   capability, not an external dependency.** Tanren owns the hard parts an
   external queue provides (DAG-aware ordering, in-place rebase integration,
   intent-preserving conflict resolution) and the verification too — the
   **native gate** runs over SSH and feeds the guaranteed fail-closed
   **`MergeAuthority`**, the sole merge decision (no GitHub Actions in the
   delivery path). Post-cutover the GitHub-shaped `VcsProvider` is decomposed by
   _purpose_ into four seams — jj `WorkspaceVcsCore` (clone/branch/rebase/resolve),
   a minimal `CodeHost` (push/fetch refs + land an authorized ref into `main`),
   the owned `MergeAuthority`, and best-effort `VisibilityProjection` (the
   PR/check/comment mirror) — so the host stays swappable (GitHub now;
   GitLab/others later) and code/review/check-publication become best-effort
   mirrors, not delivery. Mergify is gone, not an optional adapter. This is the
   headline differentiator: intelligent velocity, provider-agnostic, Action-less.
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
contract owns the queue ordering; the guaranteed fail-closed **`MergeAuthority`**
owns the merge _decision_ (post-cutover, the sole authority — see the intro note);
the run path's merge stage routes through them instead of the bare `directMerge`.

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
   then route to `MergeAuthority`. The resolution is itself inspectable (events +
   the diff).

This is the principle made concrete: **the DAG knows the intent of every change,
so a conflict is a re-planning problem, not a text-picking problem.**

Post-cutover (flag-on, default), the live resolver runs over **jj first-class
conflicts** (`conflictResolverJjLive`): a rebase that conflicts _still succeeds_
and records the conflict _in_ the commit, which the resolver then resolves — there
is no `git merge --no-ff` + `--diff-filter=U` + `merge --abort` dance and no
`|| true` that swallows infra/auth failures. "A conflict must never brick" is true
by construction: work is never discarded, the conflicted state stays local to the
runner workspace, and only resolved git-compatible refs are pushed to the host.

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

**The mechanism — integration nodes (post-cutover).** When C is ready under the
threshold and depends on A (and/or B) that are unmerged, there is **one** run
object: _work on a base that may shift._ The base is `main + an ordered set of
not-yet-landed ancestor branches` — an **`integration_nodes`** row (the same
object is an eager dependent build, a merge-queue batch, and a stacked PR; the
old speculative-vs-real divergence is killed).

1. The dependent's branch is integrated jj-locally against its ordered ancestors
   (`integrationNodesDrive`, flag-on). If ancestors conflict _with each other_, it
   surfaces **here, early** via jj first-class conflicts — intent-preserving
   resolution (§2b) runs against it, not against poor C.
2. C builds against the prospective merged world (the integration node's base).
3. **When a base shifts** — an ancestor lands, or an unrelated spec lands and
   moves a shared base — the **never-discard `BaseShiftCoordinator`** treats the
   shift as **new context**, not a reason to throw work away: it jj-rebases C's
   **existing** branch onto the shifted base (`rebaseOnto`, same run/branch row,
   same run_id), re-gates only affected tiers, and **re-plans only** when the
   rebase conflicted and the resolver + re-gate say the old work no longer fits. A
   clean rebase + passing gate **never** re-plans. Proof reuse keyed on
   `member_key + gate_config_hash + policy_version` carries a batch's gate verdict
   into the real merge so a no-op rebase skips unaffected tiers.

The hard case — C depends on A and B, both pending human review — is handled by
the integration node basing C on the ordered `A+B` ancestors: we do **not**
pre-merge A or B to unblock C. They merge on their own real review timelines,
through the queue, in dependency order; C rebases in place after each. C's _work_
proceeds in parallel, but C's _merge_ still waits — `MergeAuthority` only
authorizes C once A and B are genuinely merged. No unreviewed code reaches `main`
early.

**Base shift = never discard (replacing the old supersede + regenerate).** The
**original** change-percolation implementation, despite the prose here once
claiming "NOT discard," actually **superseded** the dependent's run — cancelled
it, dequeued it, force-pushed a fresh clone, and re-planned from scratch —
discarding every planner/writer/code token (and spawning a strand reconciler to
clean up the cancel+recreate, a whole bug-class now **deleted**, not fixed). The
post-cutover `BaseShiftCoordinator` is the real never-discard: when an ancestor
changes after dependents started (a P3 patch, a reviewer edit, a new finding), it
**jj-rebases B's existing branch in place** — keeping B's work intact, re-gating,
propagating the resolution down the stack via jj's automatic descendant rebase —
rather than cancel-and-regenerate. It is a chain re-integration, not a rollback.
Because work is never discarded, deeper eager chains are just more rebases, all
useful; the `integration.*` metrics (read-side **deferred until a run reaches a merge**, see
§7 of `tanren-owns-the-engine.md`) instrument `rebase_vs_rebuild` to _prove_
resolution costs less than rebuild rather than assume it.

Severity gates _whether_ a rebase is needed promptly: a **P0/P1** finding or
**changes-requested** on A triggers immediate re-integration; **P2/P3** changes
batch lazily into the next rebase. Nothing is ever silently merged on stale work —
and, now genuinely, nothing is ever discarded.

### 2d. The native intelligent merge queue (headline capability)

<a id="s2d"></a>Per §1.1, the merge queue is **owned natively**, not delegated.
The `MergeCoordinator` runs an in-Tanren queue that:

- **Orders** ready-to-merge PRs in **DAG order** (ancestors before dependents), by
  priority within a layer.
- **Integrates + batch-checks** the prospective merged state (the ordered `A+B+…`
  integration node from §2c), so a bad _interaction_ is caught before it hits
  `main` — and **bisects a failed batch** to find the offending PR rather than
  blocking the whole batch (proof-reuse lets bisection read prefix-node verdicts).
- **Serializes conflict-prone merges** and invokes intent-preserving resolution
  (§2b) when a real conflict surfaces, then re-gates and routes to `MergeAuthority`.
- Is **host-agnostic** via the purpose-decomposed seams (post-cutover): the queue
  logic + the `MergeAuthority` decision are Tanren's; only the thin `CodeHost`
  (push/fetch/land) and best-effort `VisibilityProjection` calls are behind the
  host adapter — GitHub today, GitLab/others later.

The native engine is strictly more capable than an external queue because it has
the DAG + spec intent that an external tool never sees. It absorbs what an
external queue would provide — merge queue + batch checks (§2d), DAG-derived
integration nodes (§2c), never-discard in-place rebase (§2c),
**flaky-test detection + auto-quarantine**, **CI
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
parallel, governed concurrency, eager dependent unblock, no milestone pauses, zero
per-spec triggers); merge coordination (never-discard in-place rebase,
intent-preserving conflict resolution, stacked dependents, the native queue +
`MergeAuthority`); the issue loop (planted
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
