import { z } from "zod";

// DagWalker events (autonomy-engine.md §1a). The DagWalker is a per-project background SCHEDULER
// over the existing run executor: on startup and on every run.*-terminal / merge.completed
// notification it loads the spec DAG, computes the ready set (pending specs whose dependencies are
// all DONE), and enqueues up to the governed concurrency headroom via createQueuedRunFromSpec. These
// events make that autonomous scheduling decision VISIBLE — every spec the walker auto-enqueues,
// every time the DAG drains, and every time the walker pauses for lack of budget headroom.
//
// Milestones are LABELS, never gates: the walker never pauses at a milestone
// boundary, so there is no milestone event here — only the real scheduling
// outcomes (enqueued / drained / budget-paused / concurrency-saturated). The
// budget pause is the GENUINE dollar-budget gate (cumulative spend ≥ the
// configured ceiling); the concurrency-saturated hold is "no in-flight slot
// free" — historically conflated under `budget.paused`, now split honestly.

// dag.spec.enqueued: the walker auto-selected a ready spec and enqueued a run for it through
// createQueuedRunFromSpec (the SAME path an operator's manual trigger uses). Carries the new run id
// + the spec it was created from, the readiness reason (deps satisfied), and the live in-flight count
// vs. the governed ceiling at enqueue time, so the timeline shows why the walker chose to run it.
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
// more of its ancestors are not yet MERGED. The dependent jj-ASSEMBLES its base
// LOCALLY at bootstrap from `main + the unmerged ancestors' PR-head branches`
// (DAG order; no synthesized host ref); its MERGE still waits for those ancestors
// to genuinely merge. This event names the unmerged ancestors + the threshold so
// the timeline shows exactly what prospective merged world the dependent built against.
export const DagSpecSpeculativePayload = z
  .object({
    specId: z.string(),
    runId: z.string(),
    // The ancestors that have crossed the threshold but are NOT yet merged — the
    // ordered stack the dependent jj-assembles its base from.
    unmergedAncestors: z.array(z.string()).min(1),
    // The configured speculation threshold that admitted this early start.
    threshold: z.enum(["conservative", "moderate", "aggressive"]),
  })
  .strict();
export type DagSpecSpeculativePayload = z.infer<typeof DagSpecSpeculativePayload>;

// dag.spec.ancestor_not_ready (tanren-owns-the-engine.md §3 never-discard): a dependent
// was driven SPECULATIVELY and reached its base-shift ASSEMBLY, but an ancestor's PR-head
// branch was GONE (no `<branch>@origin` ref) and the ancestor had NOT merged — yet the
// ancestor's SPEC is still NON-TERMINAL (`pending`/`in_flight`): it has simply not published
// its head yet (the dependent ran ahead of the ancestor reaching `pr_open`). This is BENIGN,
// NOT a fault: the dependent run finalizes as a recoverable WAIT (the spec returns to `open`,
// the run halts non-terminal) and the walker RE-DRIVES it once the ancestor publishes its
// head / merges — the never-discard re-drive, never a terminal strand. This event names the
// not-yet-ready ancestor + its phase so the timeline shows exactly why the dependent waited.
export const DagSpecAncestorNotReadyPayload = z
  .object({
    // The dependent spec/run that benign-WAITED (it did NOT strand).
    specId: z.string(),
    runId: z.string(),
    // The ancestor whose head branch had not been published yet, and its non-terminal
    // lifecycle bucket (`pending`/`in_flight`) — the proof the wait is benign (it WILL publish).
    ancestorSpecId: z.string(),
    ancestorPhase: z.enum(["pending", "in_flight"]),
  })
  .strict();
export type DagSpecAncestorNotReadyPayload = z.infer<typeof DagSpecAncestorNotReadyPayload>;

// dag.spec.redriven (apex v35) is defined in `dagRedrive.ts` (file-size cap) and re-exported here.
export { DagSpecRedrivenPayload } from "./dagRedrive.js";

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
    // The budget period the spend was summed over — mirrors the config `BudgetPeriod`
    // enum (calendar month / quarter / year, or lifetime). A calendar-anchored window
    // resets at its boundary; `total` is the lifetime cap.
    period: z.enum(["monthly", "quarterly", "annual", "total"]),
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

// dag.budget.milestone: cumulative DOLLAR SPEND crossed a budget-FRACTION boundary
// (50% / 80% of the configured ceiling) WITHOUT yet exhausting it — the
// "you're burning through the ceiling" heads-up a human wants DURING an autonomous
// run, distinct from the terminal `dag.budget.paused` (100%, run halted). Unlike
// the §1a "milestones are labels" note above, THIS is a real first-class event,
// because it is exactly the autonomy-loop signal a human cares about: the run is
// approaching its money ceiling and may soon pause. It is emitted ONCE PER BAND PER
// BUDGET WINDOW (the emitter dedups against prior milestone events in the same
// calendar window — a `monthly` ceiling re-arms each month, a `total` ceiling once
// for the project's lifetime), so re-walks never re-ping. It routes by default
// (severity `warn`) so the heads-up reaches the org's channels without per-event
// route config. Only fires when a ceiling is configured (an unlimited project
// crosses no fraction).
export const DagBudgetMilestonePayload = z
  .object({
    // The fraction band crossed — 50 or 80 (percent of the ceiling). 100 is the
    // terminal pause (`dag.budget.paused`), not a milestone heads-up.
    band: z.union([z.literal(50), z.literal(80)]),
    // The configured dollar ceiling, and the cumulative spend that crossed the band
    // (both in USD). `spentUsd / ceilingUsd >= band/100` at emit time.
    ceilingUsd: z.number().positive(),
    spentUsd: z.number().nonnegative(),
    // The budget period the spend was summed over — mirrors the config `BudgetPeriod`
    // enum. A calendar-anchored window re-arms the milestone bands at its boundary;
    // `total` arms each band once for the project's lifetime.
    period: z.enum(["monthly", "quarterly", "annual", "total"]),
  })
  .strict();
export type DagBudgetMilestonePayload = z.infer<typeof DagBudgetMilestonePayload>;

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

// dag.config.corrupt (no_silent_fallbacks): the walker read a project's persisted
// `projects.config` to resolve a NON-merge eagerness knob (the speculation
// threshold / depth cap — §2c, which gates WORK not MERGE) and the blob would not
// parse. For these eagerness knobs the SAFE schema default is genuinely correct
// (the same default a fresh project carries), so the walker proceeds — but the
// corruption must NOT be silent: it is surfaced as this observability event (and
// logged) so a corrupt persisted config is visible to an operator, not masked.
// This is the LOUD-DEFAULT side of the doctrine (vs the PROPAGATE side used where a
// corrupt config would yield wrong identity / wrong cap).
export const DagConfigCorruptPayload = z
  .object({
    // Which config-derived knob the walker was resolving when the parse failed.
    knob: z.literal("speculation_config"),
    // The default the walker fell back to (so the event records the actual posture
    // the run proceeded under, not just that a failure happened).
    appliedDefault: z
      .object({
        threshold: z.enum(["conservative", "moderate", "aggressive"]),
        depthCap: z.number().int().positive(),
      })
      .strict(),
    // The parse error's message — enough to diagnose WHY the config did not parse.
    reason: z.string(),
  })
  .strict();
export type DagConfigCorruptPayload = z.infer<typeof DagConfigCorruptPayload>;

// Change-percolation events (autonomy-engine.md §2c "Change-percolation — NOT
// discard"). When an ANCESTOR changes after a dependent started speculatively (a
// reviewer pushes new commits, a P0/P1 finding lands, changes-requested), the
// walker does NOT throw away the dependent's work — it PERCOLATES the upstream
// delta down the chain (rebuild the speculative integration with the ancestor's
// NEW state → re-base → re-gate; a conflict/semantic-break invokes the conflict
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
// the re-base/re-gate surfaced a conflict/semantic-break that the resolver
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
// routed BACK TO THE PLANNER with the ancestor's change as new context (the conflict
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

// integration.rebase (tanren-owns-the-engine.md §3, §7 — the never-discard keystone):
// the BaseShiftCoordinator handled a base shift (an ancestor landed, or an unrelated
// spec moved a shared base) by REBASING the dependent's EXISTING branch in place via
// `WorkspaceVcsCore.rebaseOnto` — KEEPING the same run/branch row — instead of the old
// supersede+regenerate (which cancelled the run, force-pushed a fresh clone, and re-ran
// the planner from scratch). The `decision` field records what the rebase cost:
//   - `rebased_clean`    — the rebase applied with no conflict + the re-gate passed; the
//                          planner/writer/code tokens were REUSED (NO re-plan). This is
//                          the win the `rebase_vs_rebuild` read-side proves: the
//                          insight (engine/insights/integration) JOINS this kept run's
//                          token/wall-clock cost AT READ TIME to compare it against the
//                          `replanned` (rebuild) cost.
//   - `rebased_resolved` — the rebase conflicted (recorded IN the commit, work survived),
//                          the resolver reconciled it (intent-preserving), and the re-gate
//                          passed — still NO re-plan (the existing work fit after resolve).
//   - `replanned`        — the rebased work NO LONGER FITS the new base, so it was routed
//                          back to the planner WITH the shift as context (work KEPT ALIVE,
//                          never discarded/merged). "No longer fits" has TWO legitimate
//                          forms, distinguished by `rebaseConflicted`: (a) the rebase
//                          CONFLICTED and the resolver could not reconcile it
//                          (`rebaseConflicted: true`), OR (b) the rebase was CLEAN but the
//                          fresh re-gate FAILED on the new base (`rebaseConflicted: false`).
//                          Both are real "the old work doesn't fit the shifted base" replans
//                          — a clean rebase whose gate fails on the new base genuinely needs
//                          re-planning, NOT a pretend-conflict.
//   - `held`             — a fail-closed hold (the rebase/resolver/gate could not settle);
//                          the work survives and is retried on the next notification.
// `sameRunId` is ALWAYS true on this path — it is the never-discard assertion made
// durable (the dependent's run row is the SAME across the shift). The recorded signal
// is the categorical `decision` (below) PLUS the kept `runId` — there is NO token or
// wall-clock field on this payload. The `rebase_vs_rebuild` read-side
// (engine/insights/integration + routes/integrationMetrics) JOINS that cost AT READ
// TIME — `cost_records` summed by `run_id` for tokens, `runs.ended_at - started_at`
// for wall-clock — to PROVE rebase < rebuild without widening this event.
export const IntegrationRebasePayload = z
  .object({
    // The dependent whose branch was rebased onto the shifted base.
    specId: z.string(),
    // The KEPT run id (the never-discard proof — same row across the base shift).
    runId: z.string(),
    // Always true on this path: the run/branch row survived the base shift.
    sameRunId: z.boolean(),
    // The branch that was rebased in place.
    branch: z.string(),
    // The shifted base the dependent was rebased ONTO (the new ancestor/main head).
    newBaseSha: z.string(),
    // The branch head after the rebase (carries a recorded conflict when conflicted).
    headSha: z.string(),
    // INFORMATIONAL: whether the jj rebase itself conflicted (a SUCCESS that recorded the
    // conflict). On `replanned` it distinguishes the two "no longer fits" forms — `true`
    // = the conflict was irreconcilable, `false` = the rebase was clean but the re-gate
    // failed on the new base. It does NOT gate the decision (a clean-rebase gate-failure
    // is a real replan).
    rebaseConflicted: z.boolean(),
    // What the base shift cost — the `rebase_vs_rebuild` signal (NO re-plan unless the
    // old work genuinely no longer fits the new base). `held` is a fail-closed hold.
    decision: z.enum(["rebased_clean", "rebased_resolved", "replanned", "held"]),
  })
  .strict();
export type IntegrationRebasePayload = z.infer<typeof IntegrationRebasePayload>;

// integration.proof.reused (tanren-owns-the-engine.md §3 — proof reuse, the
// least-repeated-work primitive): the gate/CI verdict site found a recorded PASSING
// proof whose `proofReuseKey` matched the LIVE inputs EXACTLY (all six components —
// memberKey, gateConfigHash, policyVersion, runnerImage, appEnvHash, quarantineVersion),
// so it SKIPPED the re-gate and reused the prior verdict. THE SAFETY INVARIANT: this is
// emitted ONLY on an exact six-component match against a PASSING proof; ANY drift, a
// non-passing recorded verdict, or an unresolvable key component forces a recompute
// (the gate runs) and this event is NOT emitted — a reuse can never let unproven code
// merge. `proofReuseKey` is the matched cache key (the audit handle); `nodeId` is the
// integration node the verdict was reused for; `memberKey` is the integrated-content
// identity the proof carries; `recordedOnNodeId` is the node the proof was ORIGINALLY
// recorded on (a batch proof carrying into the real merge reuses across node ids — the
// content is identical, which is what `memberKey` proves).
export const IntegrationProofReusedPayload = z
  .object({
    // The integration node the verdict was reused FOR (the current node).
    nodeId: z.string(),
    // The node the proof was ORIGINALLY recorded on (may differ from `nodeId` — a batch
    // proof carries into the real merge; the content identity is what matches).
    recordedOnNodeId: z.string(),
    // The integrated-content identity the reused proof proves (`memberKey`).
    memberKey: z.string(),
    // The full six-component cache key that matched (the audit handle).
    proofReuseKey: z.string(),
    // The reused verdict — always `passed` (only a PASSING proof short-circuits the gate).
    verdict: z.literal("passed"),
  })
  .strict();
export type IntegrationProofReusedPayload = z.infer<typeof IntegrationProofReusedPayload>;

// GENUINE-HALT escalation reasons (apex v35 — the unified run-finalize authority,
// `runFinalizeAuthority.ts`). `needs_attention` is RESERVED for the three GENUINE-HALT
// classes; a RANDOM/TRANSIENT/internal/crash/orphan fault NEVER rests here — it RE-DRIVES
// (emitting `dag.spec.redriven`). The old slot-occupying strand reasons (`halted_reexec` /
// `orphaned_marker` / `no_live_run`) are GONE: they were transient classes the per-path
// logic mis-parked; their diagnostic detail now rides `dag.spec.redriven.failureCode`.
//   - `misconfiguration` — a structural cause a human must fix (missing/unscoped credential,
//     unresolvable provider mode). Never self-heals on retry, so it escalates immediately.
//   - `persistent_failure` — the run failed the SAME classified way K consecutive times (each
//     transient RE-DRIVEN but never converged): a genuinely STUCK spec (a bug / mis-spec).
//   - `human_decision` — a genuine merge-boundary decision (a HITL hold / changes-requested).
const StrandReason = z.enum(["misconfiguration", "persistent_failure", "human_decision"]);
// One of the strand's terminal runs (its id + final status) — for the audit trail.
const StrandTerminalRun = z.object({ runId: z.string(), status: z.string() }).strict();

// dag.spec.needs_attention: a spec parked at the terminal `needs_attention` status — freeing the
// DAG slot and blocking ONLY its dependents (never the whole DAG), surfacing a loud, bounded ask-
// for-help. A discriminated union on `source` because TWO subsystems reach the SAME terminal parked
// state, each carrying its own halt history:
//   - `strand`: the NEVER-STRAND reconciler exhausted the bounded re-enqueue cap (a
//     spec stuck occupying a slot with no live run) — the canonical §2c safety net.
//   - `merge_conflict`: the native merge queue's intent-preserving conflict resolver
//     judged the spec GENUINELY irreconcilable against another in-flight spec (re-
//     executing it would just re-conflict forever), so the coordinator parked it
//     instead of blindly re-executing (autonomy-engine.md §2c — the non-bricking
//     conflict escalation). Carries the PR + the resolver's message.
//   - `cancelled_ancestor`: an operator CANCELLED an ancestor of this spec (the
//     operator cancel-spec action, workflow/cancelSpec). A dependent of a cancelled
//     spec is NOT silently dropped (the human-escalation discipline): cancelling the
//     ancestor removed the work the dependent assumed, so the dependent parks at
//     `needs_attention` for a human to DECIDE (re-scope the dependent, re-queue the
//     ancestor, or cancel the dependent too) — never an autonomous cascade-cancel.
//     Carries the cancelled ancestor's spec id.
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
  z
    .object({
      source: z.literal("cancelled_ancestor"),
      specId: z.string(),
      // The ancestor an operator cancelled — the dependency this spec assumed that
      // no longer exists, forcing the human decision.
      cancelledAncestorSpecId: z.string(),
      // The human-readable DECISION ask (the escalation discipline): framed as "an
      // ancestor was cancelled — decide how to proceed", not "an error occurred".
      message: z.string(),
    })
    .strict(),
]);
export type DagSpecNeedsAttentionPayload = z.infer<typeof DagSpecNeedsAttentionPayload>;

// dag.spec.attention_resolved: the OPERATOR (a human, never a background loop)
// resolved a `needs_attention` escalation — they ADDRESSED the underlying blocker
// (e.g. fixed a platform bug, re-scoped a dependency) and told Tanren to retry the
// spec. The spec transitions `needs_attention → open` so the autonomous DagWalker
// re-picks it up, and the spec's bounded re-plan budget RESETS (the conflict resolver
// counts only the re-plan-routed events AFTER the most recent resolution — so a
// re-queued spec genuinely re-runs the full retry budget rather than immediately
// re-escalating). This is the human-in-the-loop counterpart to
// `dag.spec.needs_attention`: the loud, actor-stamped "addressed, proceed" decision
// (the escalation discipline). `fromSource` records which subsystem had parked it.
export const DagSpecAttentionResolvedPayload = z
  .object({
    specId: z.string(),
    // Which subsystem had parked the spec (mirrors the needs_attention `source`),
    // so the timeline links the resolution to the escalation it answers.
    fromSource: z.enum(["strand", "merge_conflict"]),
    // The actor who resolved it (the operator's user id) — actor-stamped, non-secret.
    resolvedBy: z.string(),
  })
  .strict();
export type DagSpecAttentionResolvedPayload = z.infer<typeof DagSpecAttentionResolvedPayload>;
