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

> **The tanren-owns-the-engine cutover is COMPLETE — the single live path.** The
> merge coordination described in §2 was originally built on a `VcsProvider`-shaped,
> speculative-integration-plus-change-percolation model. That model has since been
> **superseded and the cutover completed**: a jj (jujutsu) `WorkspaceVcsCore` is the
> VCS core, a guaranteed fail-closed **`MergeAuthority`** is the sole merge decision,
> a **never-discard** `BaseShiftCoordinator` rebases dependent work in place (the old
> "supersede + regenerate" percolation that _did_ discard and re-plan work is gone),
> and the auditor emits **P0–P3 findings** gated by an **`auditPosture`** DORA knob.
> The cutover is **no longer flag-gated** — the WS-A/WS-B series deleted the
> kill-switch env vars (`MERGE_AUTHORITY_LIVE`, `CONFLICT_RESOLVER_JJ_LIVE`,
> `BASE_SHIFT_LIVE`, `INTEGRATION_NODES_DRIVE`, `WALKER_JJ_LOCAL_BASE`); each live
> path is unconditional, the dependent run jj-assembles its base from the real
> ancestor PR-head refs (no synthesized `tanren/integ` ref), and the legacy
> `speculative_base` + `integrated_ancestor_shas` columns are dropped. These live
> paths are **first exercised end-to-end by an apex run that closes the
> product→merge→deploy loop** — no such run has landed yet (apex v32 halted at
> scaffold-bootstrap before a merge; v36 proved the #601 recovery to 10/11 on
> template creation but did not close the product→deploy loop; successive trials —
> v37–v46 ran on the previous WSL host through 2026-06-19; v47–v64 ran on the new
> NixOS host and drove real engine bugs to fixes; and the 2026-06-30 → 2026-07-04
> apex-daily cadence carried the frontier through **v65–v79**, each halt producing a
> fix-on-`main` merge — the current frontier halted on out-of-scope-finding routing
> (v79 fix: triage → new-spec insertion, PR #734), moving past the earlier
> infra-hang class entirely). A real merge through the jj/`MergeAuthority` path is
> therefore still the open live-validation item — the engine is the single path on
> `main` regardless. §2b/§2c below are rewritten to the never-discard reality; the
> full rationale, the unified `integration_nodes` run model, and the residual §7
> simplification are in `docs/architecture/tanren-owns-the-engine.md`.

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
   adds webhooks — §1d.) Every subscriber shares a single
   `subscribeWithReconnect` helper (Wave D2, PR #746) that survives boot-time
   PG blips, connection errors, and rapid-fire wake races — the four consumers
   (walker, notify-subscriber, orphan-consecutive-reader, redrive-history-reader)
   all attach through it; the round-3 wake-latch (PR #767) also closes the
   error-before-park race so a reconnect requested before the parked wake
   promise resolves is not lost.
6. **Contracts-as-durable-asset.** Each new capability is a seam with a
   conformance suite (like `Allocator` / `JobQueue` / `Repositories`), so the
   `CodeHost` adapter (GitHub now, GitLab/others later), an optional external-queue
   adapter, and the eventual Rust rewrite all slot in.
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

## 1c. Run-finalize — the ONE authority, the 3-bucket model

<a id="s1c"></a>Every run attempt has exactly **one** terminal outcome, and that
outcome maps to exactly **one of three buckets**. This is the binding model — and
it lives in **one** decision authority (`engine/workflow/runFinalizeAuthority.ts`,
`decideRunDisposition`), applied identically whether the outcome arrives via the
**workflow** path (the planner-loop's own `catch` + non-pass exits + the merge
stage), the **worker** path (`runExecutor.ts`'s outer catch), or the **orphan
reconciler** (`runFinalize.ts`'s crashed-slot safety net). The decision is a pure,
DB-free core; the **appliers** (`plannerRunRedrive.ts`, `plannerRunFinalize.ts`,
`runFinalize.ts`) perform the lifecycle writes the verdict dictates.

1. **RE-DRIVE (retry).** Any **random / transient / internal / flaky /
   writer-mistake / codex-hiccup / merge-conflict-resolvable / crashed-run /
   orphaned-slot** failure. The run halts **recoverable** (work never discarded),
   the spec returns to `open`, the walker enqueues a successor run, and an
   **observable `dag.spec.redriven`** event records the retry. A random failure is
   **never** tolerable as terminal. The re-drive is **UNBOUNDED while it is making
   PROGRESS** — there is **NO hardcoded attempt count**, no `K`, no `MAX_*`, no
   wall-clock deadline. It escalates **only** at an intelligently-detected **FIXED
   POINT** (the shared `convergenceDetector`, §1c.1): the _same_ classified failure
   recurring with the _same_ produced work and no new information. A **different**
   failure, or the **same** failure but **different** produced work, is PROGRESS and
   keeps re-driving, forever; backoff (grown with the stuck streak) prevents a
   hot-loop **without** a counter. A benign ancestor-wait re-drives with **no**
   fault (it never reaches the detector; the ancestor _will_ publish its head).

2. **GENUINE-HALT.** **Only** four structural classes: **budget exhaustion**
   (`dag.budget.paused`), **misconfiguration** (a missing/unscoped credential, an
   unresolvable provider mode), **mis-spec** / **persistent-failure** (a genuine
   FIXED POINT — the same failure + same work, intelligently detected, NOT a count),
   and a **genuine human-decision** (a real product/architecture decision a human
   must _make_ — e.g. a HITL hold or changes-requested at land time). These →
   `needs_attention` with a **specific, actionable reason** (`misconfiguration` /
   `persistent_failure` / `human_decision`). `needs_attention` is **reserved** for
   these — a transient fault never rests here.

3. **CONVERGE.** Success — the PR landed (`merged` / `done`).

A run attempt is finalized **exactly once** by this authority (the
single-finalize invariant): the workflow's own finalizer runs first and fully; a
re-driven attempt is terminally disposed of (the workflow returns normally, never
re-throwing into the worker's strand path); a genuine-halt re-throws **wrapped** in
`WorkflowFinalizedError` so the worker skips its safety-net re-finalize; a
**genuinely orphaned** crash (the workflow finalizer never ran, a _raw_ error
escapes) is the worker's safety net — and, because a crash is a transient class, it
too **re-drives** (bounded by the same fixed-point detector), never the old
terminal strand. There is **no whole-DAG wall-clock deadline** — a build runs until
CONVERGE or GENUINE-HALT, re-driving everything else (the build driver's
converge-or-genuine-deadlock termination uses the shared `specProgress`
classification: it halts loud only when **no** spec can make forward progress, never
on a transient).

This **collapses** the old fragmentation: the per-path strand reasons
(`halted_reexec` / `orphaned_marker` / `no_live_run`) are gone — they were transient
classes the scattered per-path logic mis-parked (the same transient failure stranding
under _three_ different reasons run-to-run). They now all RE-DRIVE; their diagnostic
detail rides `dag.spec.redriven.failureCode`, not a distinct terminal behavior.

### 1c.1 — The intelligent non-convergence detector (no hardcoded attempt caps)

<a id="s1c1"></a>**The binding principle:** there is **NEVER a hardcoded number of
attempts for ANYTHING.** The only thing that causes escalation is an intelligent
detection that a loop is **not converging** — which does **not** mean lack of
advancement (slow / many-tries is fine), it means it is not making **PROGRESS** (the
same failure repeating with no real change). **Every** convergence loop — the
run-finalize re-drive (§1c), the base-shift / conflict re-plan (§2b), the
batch-gate-rework, the template-build recovery, the spec-implementation
writer/checker/auditor loop, and the review-rework / pre-merge-gate self-heal —
continues **UNBOUNDED** while it is converging and escalates **only** when
intelligently detected to be genuinely stuck. No `K`, no `MAX_*`, no fixed budget,
no operator-tunable count — anywhere. (The old `EscapeHatches` config block — a
`maxWriterIterPerSubtask` / retry / discovery-round count — is **deleted**; the
config gate and benchmark dimensions drop it. The in-loop `maxConsecutiveStalls`
config knob is **deleted** too.)

One shared assessor (`engine/workflow/convergenceDetector.ts`) every loop maps its
history onto:

- **PROGRESS signal (cheap, structural, the common case).** An attempt made progress
  over the prior one if **any** axis advanced: its **failure SIGNATURE** changed (a
  different error / tier / step / root cause), OR the **WORK** it produced changed (a
  different diff / result-tree / head), OR its **MAGNITUDE** shrank (fewer errors, a
  smaller defect, more criteria passing — the **1000 → 500 → 100 → 1** type-error
  trajectory is genuine progress at _every_ step even though each step still fails).
  While there is progress → **CONTINUE, unbounded.** Advancement / slowness / many
  tries **NEVER** escalate.

- **Suspected FIXED POINT.** Only when an attempt is indistinguishable from the prior
  on every observable axis (same failure **and** same work **and** non-shrinking
  magnitude — no new information) is escalation even _considered_. The fixed-point
  detection itself is the loop-breaker — it replaces the counters _without_ a count.

- **INTELLIGENT escalation gate (agent-assessed where the answerer infra exists).** At
  a suspected fixed point the decision is the bar **"would a human do anything other
  than say 'keep going, you're almost there'?"** If a human would just say keep going
  (slow / hard / a different approach still worth trying), Tanren **keeps going**.
  Escalation is **RARE** — reserved for cases where human input would genuinely change
  the outcome: an ambiguous requirement, a missing resource/credential, a genuine
  product/architecture decision, or a demonstrably-exhausted dead-end with no new
  approach. The **spec-implementation loop** makes this gate **agent-assessed**: the
  convergence answerer emits an `escalation: keep_going | escalate` verdict (+ a
  human-actionable `escalationReason`) framed as exactly that bar — so even a stuck
  blocking root cause keeps iterating until the _agent_ judges a human is genuinely
  needed. The **durable loops** (re-drive / re-plan / rework / recovery), whose
  escalation point is a bare DB-driven decision with no answerer, use the rigorous
  **fixed-point rule**: escalate only at a _provable_ fixed point (identical failure +
  identical work, no new information), with a specific human-actionable diagnosis. The
  escalation target is always a genuine `needs_attention` (`persistent_failure` /
  `human_decision`) carrying that diagnosis — never a silent strand, never a hot-loop.

## 1d. Autonomous intake — webhook-first, poll-fallback

<a id="s1d"></a>Issue/signal intake runs **without an operator clicking
`ingest`**, in two modes per source:

- **Webhook receivers (push)** where the source supports them — GitHub issues
  currently land on a receiver route. An event arrives → real-LLM
  triage → `auto_routable` candidates become specs **inserted into the DAG** with
  dependencies + priority; everything else lands in the candidate inbox for
  operator review (with the 1-click/chat affordance).
- **Polling (pull) fallback** for sources/configs without a webhook — a scheduled
  poller on a per-source interval. Additional providers must enter through the
  integration connection/grant authority; raw per-source token references are
  not a provider extension mechanism.

Both honor rate limits + budget. This closes the issue-driven loop autonomously,
preferring real-time push over polling where the integration allows.

## 1e. Design is a first-class engine concern (the no-handoff moat)

<a id="s1e"></a>Tanren **owns design natively** — it does not hand a brief to an
external design tool and import the result. The durable artifact is a
**`DesignContract`** (`engine/design/designContract.ts`), a typed, persisted,
versioned design-intent contract with a **domain-general** shape: a universal core
(`identity` / `intent` / `principles` / `constraints`), a descriptive `domain`
label Tanren never branches on, and a **domain-declared `dimensions` set** (a SaaS
app's `tokens/components/layout`; a game's `art-direction/ui/game-feel`; a novel
translation's `typography/voice/cover`). This is the same generality posture as the
project-declared lifecycle (stack-flexible) and the template manifest — the web
"design system" is one instance of the contract, not the model.

The **moat** is the first-class link into Tanren's own entity graph: a
`DesignContract` carries `personaRefs` + `behaviorRefs` resolved against the real
`personas` / `behaviors` tables. An external design tool must _ask_ "who is this
for? assume admin?" and throw a freeform `DESIGN.md` over a wall; Tanren resolves
design **per-persona** and binds **behavior coverage as design acceptance
criteria**, so the design agent, the writer, and the oracle all reason over the
same typed entities — no designer↔implementor disconnect.

Design threads through the build loop as first-class stages, not an afterthought:

1. **Author** — a project-level **design phase** (`engine/design/designPhase.ts`)
   runs the **design agent** once in the derive flow, after personas + behaviors
   exist (so the moat refs resolve) and before build nodes run, elaborating the thin
   captured intent into the project's HEAD `DesignContract` version. It fails closed:
   exhaustive behavior coverage is asserted and every persona/behavior ref must
   resolve to a real id (a dangling ref throws — never a silent drop).
2. **Inject** — the writer-context builder (`engine/design/designWriterContext.ts`)
   threads the HEAD contract straight into Tanren's _own_ implementing agent in the
   same loop, rendering a persona-scoped, behavior-linked design block. A project
   with no contract yields no block (a real empty state, never a fabricated default).
3. **Verify** — a **design oracle** (`engine/workflow/designOracleLoopStage.ts`)
   runs as a post-audit finding stage in the spec loop (gated by a wired design
   actor, alongside the demo-run gate), judging the built output's fidelity against
   the contract's dimensions and emitting findings into the same P0–P3 stream the
   auditor uses. Design regressions re-drive like any other finding.

The contract follows the same fail-closed, no-silent-default discipline as the
template manifest and the `ci.yml` parser: a malformed contract throws; an absent
contract is an explicit no-contract state, never a defaulted one. The typed
error union is `DesignContractCorruptError` (persisted-record parse failure) /
`DesignOracleActorConfigError` (actor wired without an `orgId`) /
`MalformedDesignOracleResultError` (missing/malformed `hasContract` field) —
each fails LOUD rather than degrading silently (Wave D2, PR #745). The
`design_contracts.mode` column (migration 0026 — Wave D4, PR #756) scopes
persistence to `from_scratch` mode with a `(project_id, mode, version)`
unique index; a scaffold spec (`specialize_seed` mode) sees no contract by
construction, an intentional gap documented in
`docs/roadmap/native-design-subsystem.md`. Elsewhere in the engine the
`MalformedAncestorStackError` (Wave D1, PR #740) classifies a malformed
ancestor-stack column distinctly from an absent one, and the worker-level
`runFailureClassifier` (Wave E-fix, PR #766) gains 4 typed arms for
context-hydration + pre-row paths so a throw before the task row exists
still classifies loud instead of degrading to `crashed`.

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

Post-cutover (the unconditional live path), the live resolver runs over **jj
first-class conflicts**: a rebase that conflicts _still succeeds_
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
   (the unconditional live path). If ancestors conflict _with each other_, it
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
useful; the `integration.*` metrics (read-side **built** — route + compute +
insights, see §7/§8 of `tanren-owns-the-engine.md`) instrument `rebase_vs_rebuild`
to _prove_ resolution costs less than rebuild rather than assume it.

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

**Proof state (honest):** the end-to-end claim is **not yet closed**. apex v32
halted at scaffold-bootstrap before a merge; v36 proved the #601 recovery to 10/11
on template creation but did not reach the product→deploy loop; successive trials —
v37–v46 ran on the previous WSL host through 2026-06-19; v47–v64 ran on the new
NixOS host and drove real engine issues to fixes (timeout-eradication survivors,
watchdog probe gap, ancestor backoff, apex-mode env-var eradicated #646, Lane T1
autonomous audit posture on the synthetic child #659, and — through the roll-up
audit-round-2/round-3 landings 2026-06-29, PRs #708–#718 — the writer-seam doctrine
sweep, designOracle mode-aware, subtaskLoop iteration extraction, priorEvents
discipline, and specMode plumbing). The 2026-06-30 → 2026-07-04 apex-daily cadence
carried the frontier through **v65–v79**, each halt producing a fix-on-`main` merge:
autostash gate artifacts on clean-PR rebase (v65, #715); F2 fragment-authoring
observability (v66, #719); re-drive halt observability + the wandering-halt
convergence detector (v67, #720/#721); enqueue pushed PR into `merge_queue` (v67/v69,
#724) and the atomic 3-write seam + orphaned-PR startup sweep (#725);
eventStore-accepts-org-scoped-events (v68, #723); plan-stage answerer stall-recovery
(v70, #726); squash writer commits before clean-PR rebase (v71, #728); pnpm bootstrap
non-interactive (v71/v78, #733); compose smoke recognizes Go/Python/Rust tests (v72,
#729); reconcile duplicate `addEnvVar` across fragments (v75, #730); planner
one-concern-per-subtask sizing (v76, #731); `ActivityWatchdog` neighbor-floor widened
to 5 for agent-class execs (v76/v77, #732); and the **v79** frontier — triage routes
out-of-scope findings to new specs (#734), the issue-triage → new-spec insertion
mechanic firing on real out-of-scope findings, the closest to the issue-loop half
of the apex proof firing autonomously. The current frontier has moved past the
v49-era infra-hang class (runner-INSERT PK race + derive synchronous-wait circuit
breaker, task #21 merged as PR #705) into the product-build loop — writer subtask
sizing, plan stall recovery, template composition semantics, PR-enqueue timing,
triage → new-spec routing. **The v79-era product-build-loop frontier was HARDENED
across 34 PRs (#738–#768) landed 2026-07-05 → 2026-07-07** closing every
Codex-critic / round-3 / RA1 / RA2 finding (Waves D1..D4 + E-fix + F); **a
subsequent Wave H + F2 hardening push landed 2026-07-07 — 26 more PRs
(#774–#799)** preemptively closed the F2 fragment authoring path. The
autonomous-loop machinery and the F2 authoring pipeline are complete and
hardened by regression pins. Every capability is **built and on `main`**; the bar
is clear; it has not yet been cleared (no single run has produced: rough notes →
merged spec → product build → planted issue auto-triaged → merged fix → live deploy
→ a working product URL). This section describes the workload apex _forces_ and the
bar it _must_ clear, not a cleared bar.

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
deficiency → real issue → triage → spec → DAG-insert → execute → merge); **native
design** (a `DesignContract` authored from the interview, injected into the writer,
and verified by the design oracle against the deployed web UI — §1e); and
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
  **hard failure** when unconfigured (e.g. `UnconfiguredAllocator`'s throw for an
  unrouted allocator kind). A seam whose real impl exists but is unwired fails
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
