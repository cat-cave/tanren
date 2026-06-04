import { z } from "zod";

// DagWalker events (autonomy-engine.md §1a). The DagWalker is a per-project
// background SCHEDULER over the existing run executor: on startup and on every
// run.*-terminal / merge.completed notification for the project it loads the spec
// DAG, computes the ready set (pending specs whose dependencies are all DONE),
// and enqueues up to the governed concurrency headroom of ready specs via the
// existing createQueuedRunFromSpec path. These events make that autonomous
// scheduling decision VISIBLE — every spec the walker auto-enqueues, every time
// the DAG drains, and every time the walker pauses for lack of budget headroom.
//
// Milestones are LABELS, never gates: the walker never pauses at a milestone
// boundary, so there is no milestone event here — only the real scheduling
// outcomes (enqueued / drained / budget-paused / concurrency-saturated). The
// budget pause is the GENUINE dollar-budget gate (cumulative spend ≥ the
// configured ceiling); the concurrency-saturated hold is "no in-flight slot
// free" — historically conflated under `budget.paused`, now split honestly.

// dag.spec.enqueued: the walker auto-selected a ready spec and enqueued a run for
// it through createQueuedRunFromSpec (the SAME path an operator's manual trigger
// uses). Carries the new run id + the spec it was created from, the readiness
// reason (deps satisfied), and the live in-flight count vs. the governed ceiling
// at enqueue time, so the timeline shows exactly why the walker chose to run it.
export const DagSpecEnqueuedPayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    // The dependency spec ids that were all DONE, making this spec ready. Empty
    // for a root spec (no dependencies).
    satisfiedDependsOn: z.array(z.string()),
    // The in-flight run count BEFORE this enqueue and the governed ceiling, so an
    // operator can see the headroom the walker scheduled into.
    inFlightBefore: z.number().int().nonnegative(),
    concurrencyCeiling: z.number().int().positive(),
  })
  .strict();
export type DagSpecEnqueuedPayload = z.infer<typeof DagSpecEnqueuedPayload>;

// dag.drained: a walker tick found NO more work to do for the project — every
// spec is either done or in-flight, and no pending spec is ready. The DAG is
// fully scheduled; the walker idles until the next run-terminal notification
// re-triggers it (e.g. an in-flight spec finishing unblocks a dependent).
export const DagDrainedPayload = z
  .object({
    // The spec-count breakdown at drain time, so the timeline shows WHY there was
    // nothing to enqueue (all done, vs. some still in-flight, vs. some blocked).
    doneCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    // pending specs still blocked on an unfinished dependency (not ready yet).
    blockedCount: z.number().int().nonnegative(),
  })
  .strict();
export type DagDrainedPayload = z.infer<typeof DagDrainedPayload>;

// dag.spec.speculative (autonomy-engine.md §2c): the walker started a dependent
// SPECULATIVELY — it crossed the configured speculation threshold while one or
// more of its ancestors are not yet MERGED. The dependent's PR bases on a
// speculative integration branch (main + the unmerged ancestors' branches merged
// in DAG order); its MERGE still waits for those ancestors to genuinely merge.
// This event names the unmerged ancestors + the threshold so the timeline shows
// exactly what prospective merged world the dependent built against.
export const DagSpecSpeculativePayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    // The ancestors that have crossed the threshold but are NOT yet merged — the
    // members of the speculative integration branch the dependent bases on.
    unmergedAncestors: z.array(z.string()).min(1),
    // The configured speculation threshold that admitted this early start.
    threshold: z.enum(["conservative", "moderate", "aggressive"]),
    // The integration branch ref the dependent's PR bases on (the prospective
    // merged world). Present so the timeline links the dependent to its base.
    integrationBranch: z.string(),
  })
  .strict();
export type DagSpecSpeculativePayload = z.infer<typeof DagSpecSpeculativePayload>;

// dag.spec.speculation_held (autonomy-engine.md §2c open decision §6): a dependent
// WOULD be ready under the threshold, but its unmerged-ancestor DEPTH exceeds the
// configured cap. Rather than silently truncating the integration stack (the "no
// silent caps" rule), the walker HOLDS the spec until enough ancestors merge and
// records WHY here. The walker re-evaluates on the next ancestor-merge notification.
export const DagSpecSpeculationHeldPayload = z
  .object({
    specId: z.string(),
    // The full unmerged-ancestor stack the spec would have needed (its depth).
    unmergedAncestors: z.array(z.string()).min(1),
    depth: z.number().int().positive(),
    // The configured max integration depth the stack exceeded.
    depthCap: z.number().int().positive(),
  })
  .strict();
export type DagSpecSpeculationHeldPayload = z.infer<typeof DagSpecSpeculationHeldPayload>;

// dag.budget.paused (autonomy-engine.md §3 proof 6): the walker had ready specs to
// enqueue but STOPPED because the project's cumulative DOLLAR SPEND over the
// configured budget period has reached the configured ceiling. This is the GENUINE
// budget gate — the real "budget ceiling enforced → run pauses on exhaustion"
// outcome. New spec runs are not enqueued this tick; in-flight runs are NOT killed
// (they are bounded by the escape hatches). The walker re-evaluates on the next
// notification — if spend later falls under the ceiling (a `total`-period ceiling
// never does; a `monthly` one resets at the month boundary) it resumes.
export const DagBudgetPausedPayload = z
  .object({
    // The configured dollar ceiling that was reached, and the cumulative spend
    // measured against it over the configured period (both in USD).
    ceilingUsd: z.number().nonnegative(),
    spentUsd: z.number().nonnegative(),
    // The budget period the spend was summed over (calendar month vs. lifetime).
    period: z.enum(["monthly", "total"]),
    // How many ready specs the walker held back because the ceiling was reached.
    readyHeldBack: z.number().int().nonnegative(),
    // BUDGET-SAFETY (C1b / M5): present when the pause is a FAIL-CLOSED safety
    // pause rather than a genuine ceiling-reached pause. `unpriced_spend` — the
    // window has unattributed NULL-cost rows (an unrecognized credential ref that
    // should have priced) so the true spend is unknown and assumed over-ceiling;
    // `unparseable_config` — a present-but-undecodable budget config. Absent on
    // the ordinary ceiling-reached pause.
    reason: z.enum(["unpriced_spend", "unparseable_config"]).optional(),
  })
  .strict();
export type DagBudgetPausedPayload = z.infer<typeof DagBudgetPausedPayload>;

// dag.concurrency.saturated: the walker had ready specs to enqueue but the
// project's in-flight count is already at the governed CONCURRENCY ceiling (the
// headroom is zero) — distinct from a dollar-budget pause. This was historically
// (and misleadingly) emitted as `dag.budget.paused`; the two are now split so the
// timeline distinguishes "no slot free" from "out of money". The walker
// re-evaluates on the next run-terminal notification when a slot frees.
export const DagConcurrencySaturatedPayload = z
  .object({
    // How many ready specs the walker could not enqueue because no slot was free.
    readyHeldBack: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    concurrencyCeiling: z.number().int().positive(),
  })
  .strict();
export type DagConcurrencySaturatedPayload = z.infer<typeof DagConcurrencySaturatedPayload>;

// Change-percolation events (autonomy-engine.md §2c "Change-percolation — NOT
// discard"). When an ANCESTOR changes after a dependent started speculatively (a
// reviewer pushes new commits, a P0/P1 finding lands, changes-requested), the
// walker does NOT throw away the dependent's work — it PERCOLATES the upstream
// delta down the chain (rebuild the speculative integration with the ancestor's
// NEW state → re-base → re-gate; a conflict/semantic-break invokes the P2b
// intent-preserving resolver in UPSTREAM-CHANGE mode). These events make that live
// re-integration visible: which ancestor changed, why (severity), and the outcome.

// dag.spec.percolating: the walker detected an ancestor change (the ancestor's
// head SHA diverged from the SHA the dependent integrated against, OR a blocking
// lifecycle/finding change) and is STARTING to percolate it into the dependent —
// rebuilding the integration branch against the ancestor's new state, ready to
// re-base + re-gate. The promptness (`severity`) explains WHY it fired now.
export const DagSpecPercolatingPayload = z
  .object({
    // The dependent whose speculative work absorbs the upstream change.
    specId: z.string(),
    runId: z.string(),
    // The ancestor that changed (the source of the percolated delta).
    ancestorSpecId: z.string(),
    // The ancestor head SHA the dependent had integrated against (the OLD base).
    fromAncestorSha: z.string(),
    // The ancestor's NEW head SHA the percolation re-integrates against.
    toAncestorSha: z.string(),
    // Why this percolation is happening promptly: an open P0/P1 finding or a
    // changes-requested verdict on the ancestor forces IMMEDIATE percolation; a
    // P2/P3 change would instead defer (dag.spec.percolation_deferred).
    // `ancestor_merged` is the §2c "ancestor-merged → proactive re-base" axis: the
    // ancestor merged to default_branch (a squash-merge leaves its run branch put, so
    // the SHA-advance rules miss it) and the descendant is re-based onto fresh main,
    // dropping the now-merged ancestor from the speculative stack.
    severity: z.enum(["P0", "P1", "P2", "P3", "changes_requested", "ancestor_merged"]),
  })
  .strict();
export type DagSpecPercolatingPayload = z.infer<typeof DagSpecPercolatingPayload>;

// dag.spec.percolated: the upstream change was successfully absorbed — the
// dependent's integration was rebuilt against the ancestor's new state, re-based,
// and the re-gate (gate + checker + auditor) passed against the new base while the
// dependent's OWN work stayed intact. The new integrated SHA is recorded so a
// no-op re-trigger does not re-percolate (termination). `viaResolver` is true when
// the re-base/re-gate surfaced a conflict/semantic-break that the P2b resolver
// (upstream-change mode) reconciled before the clean re-gate.
export const DagSpecPercolatedPayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    ancestorSpecId: z.string(),
    // The ancestor SHA now recorded as integrated (the divergence key going fwd).
    integratedAncestorSha: z.string(),
    // True when the intent-preserving resolver reconciled a break before re-gate.
    viaResolver: z.boolean(),
  })
  .strict();
export type DagSpecPercolatedPayload = z.infer<typeof DagSpecPercolatedPayload>;

// dag.spec.percolation_deferred (LAZY): the ancestor changed, but the change is
// non-blocking polish (the ancestor's open findings are only P2/P3 and there is no
// changes-requested verdict), so the percolation is BATCHED into the dependent's
// next rebase rather than prompted now. Nothing is silently merged on stale work —
// the deferral is recorded so the next walk/merge re-evaluates it.
export const DagSpecPercolationDeferredPayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    ancestorSpecId: z.string(),
    // The diverged head SHA that will be folded into the next rebase.
    pendingAncestorSha: z.string(),
    // The non-blocking severity that made this lazy (P2/P3 only).
    severity: z.enum(["P2", "P3"]),
  })
  .strict();
export type DagSpecPercolationDeferredPayload = z.infer<typeof DagSpecPercolationDeferredPayload>;

// dag.spec.percolation_replan: the percolation could NOT reconcile the upstream
// change with the dependent's work (the resolver returned irreconcilable, or the
// re-gate failed). The dependent's work is NOT discarded and NOT merged — it is
// routed BACK TO THE PLANNER with the ancestor's change as new context (the P2b
// replan path), so the intent stays alive and is re-planned on top of the change.
export const DagSpecPercolationReplanPayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    ancestorSpecId: z.string(),
    // The ancestor SHA whose change the dependent must now re-plan on top of.
    ancestorSha: z.string(),
    // Why it could not be auto-absorbed (resolver-irreconcilable / re-gate failure).
    reason: z.string(),
  })
  .strict();
export type DagSpecPercolationReplanPayload = z.infer<typeof DagSpecPercolationReplanPayload>;

// NEVER-STRAND reconciler events: the DAG's self-healing safety net. A spec can get
// stuck OCCUPYING A SLOT (`active`/`in_flight`) with NO live run — the recurring
// stranding bug (a percolation §2c re-exec halts → the spec stays `active`, both its
// runs terminal, the orphaned marker can't self-heal). The reconciler detects the
// confirmed strand (slot-occupying + all runs terminal + not merge-queued + no LIVE
// percolation marker) and re-enqueues it, with BOUNDED escalation to a loud
// needs_attention. These events make every heal + every escalation VISIBLE.

// The reason a confirmed strand was detected — shared by both strand events.
const StrandReason = z.enum(["halted_reexec", "orphaned_marker", "no_live_run"]);
// One of the strand's terminal runs (its id + final status) — for the audit trail.
const StrandTerminalRun = z.object({ runId: z.string(), status: z.string() }).strict();

// dag.spec.unstranded: the reconciler confirmed a strand (a spec OCCUPYING A SLOT
// with every run terminal, not merge-queued, no LIVE percolation marker) and
// re-enqueued it (flipped `active → pending` so the DagWalker re-runs it),
// clearing any orphaned percolation marker. `attempt` is the 1-based re-enqueue
// count for this spec (it escalates to needs_attention once it would EXCEED the cap).
export const DagSpecUnstrandedPayload = z
  .object({
    specId: z.string(),
    // Why the strand was reconcilable (the canonical §2c cause is a halted re-exec).
    reason: StrandReason,
    // The spec's terminal runs (ids + statuses) that confirmed the strand.
    terminalRuns: z.array(StrandTerminalRun),
    // The 1-based attempt number this re-enqueue represents (prior unstrands + 1).
    attempt: z.number().int().positive(),
  })
  .strict();
export type DagSpecUnstrandedPayload = z.infer<typeof DagSpecUnstrandedPayload>;

// dag.spec.needs_attention: a spec parked at the terminal `needs_attention` status —
// freeing the DAG slot and blocking ONLY its dependents (never the whole DAG),
// surfacing a loud, bounded ask-for-help. A discriminated union on `source` because
// TWO subsystems reach the SAME terminal parked state, each carrying its own halt
// history:
//   - `strand`: the NEVER-STRAND reconciler exhausted the bounded re-enqueue cap (a
//     spec stuck occupying a slot with no live run) — the canonical §2c safety net.
//   - `merge_conflict`: the native merge queue's intent-preserving conflict resolver
//     judged the spec GENUINELY irreconcilable against another in-flight spec (re-
//     executing it would just re-conflict forever), so the coordinator parked it
//     instead of blindly re-executing (autonomy-engine.md §2c — the non-bricking
//     conflict escalation). Carries the PR + the resolver's message.
// One event type (no new event / no events-CHECK migration) so the DAG/UI consume the
// parked state uniformly regardless of which subsystem escalated it.
export const DagSpecNeedsAttentionPayload = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("strand"),
      specId: z.string(),
      reason: StrandReason,
      // The spec's terminal runs at escalation time (the halt history).
      terminalRuns: z.array(StrandTerminalRun),
      // How many times the spec had already been re-enqueued (exceeded the cap).
      attempts: z.number().int().nonnegative(),
      // The human-readable DECISION ask (the escalation discipline): framed as
      // "the autonomous self-heal could not make progress — a human must decide",
      // NOT "an error occurred". Mirrors the merge_conflict source's `message` so
      // both parked-state reasons surface as decisions, not error reports.
      message: z.string(),
    })
    .strict(),
  z
    .object({
      source: z.literal("merge_conflict"),
      specId: z.string(),
      // The PR whose merge the resolver found genuinely irreconcilable.
      prUrl: z.string(),
      prNumber: z.number().int(),
      // The resolver's human-readable reason the conflict could not be reconciled.
      message: z.string(),
    })
    .strict(),
]);
export type DagSpecNeedsAttentionPayload = z.infer<typeof DagSpecNeedsAttentionPayload>;
