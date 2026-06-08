// The `ChangePercolation` seam (autonomy-engine.md §2c "Change-percolation — NOT
// discard"). This is the DIFFERENTIATOR: when an ANCESTOR A changes AFTER its
// dependents B, C started speculatively (a reviewer pushes new commits to A, a new
// P0/P1 finding lands, A is changes-requested, a P2/P3 patch applies), the walker
// must NOT throw away B's and C's work. It treats A's change as a DELTA to
// PERCOLATE down the chain: rebuild B's speculative integration with A's NEW state
// (reusing the SpeculativeIntegrator), re-base B onto it, and RE-EXECUTE B
// THROUGH A REAL RUN so B's own gate + checker + auditor genuinely re-run against
// the percolated change (the planner re-plans / the upstream-change resolver
// reconciles on a break, keeping B's work intact). It is a CHAIN RE-INTEGRATION,
// not a rollback.
//
// CRITICAL — the re-gate is a REAL RUN, observed across passes. A re-base alone is
// NOT verification (that was the original change-percolation defect). Percolation is therefore
// TWO-PHASE and event-driven, settled over the LISTEN/NOTIFY bus the walker rides:
//   - KICK-OFF (immediate change, not already in flight): rebuild + re-base the
//     dependent onto the ancestor's new head, write the IN-FLIGHT marker, and
//     re-enqueue the dependent for re-execution (the DagWalker createQueuedRunFromSpec
//     path — gate/checker/auditor run INSIDE that run, no second runner). Emit
//     `percolating`. The dependent is "percolating", NOT yet "absorbed".
//   - SETTLE (a later pass, after the re-execution terminates): the dependent's new
//     run reached audited-clean (no open P0/P1) ⇒ record the ancestor SHA in
//     `verified_ancestor_shas` (the ABSORBED / termination key), clear the marker,
//     emit `percolated`. The re-execution went to replan / halted (planner /
//     resolver could not reconcile) ⇒ emit `percolation_replan` (work ALIVE, routed
//     back with the change as context). Still building ⇒ in-flight, skip (the loop
//     guard — a sticky signal never re-emits).
//
// This module carries the SEAMS the coordinator composes (the detect read model ·
// the kick-off operation · the settle seam · the chain event emitter) PLUS the PURE
// cores (`decidePercolation` detect + `decideSettle`) so the detect/severity and
// the settle logic are conformance-tested with no DB, runner, or model.
//
// The three INVARIANTS this seam enforces (what the verifier hammers):
//   - NEVER DISCARD — a percolation that cannot reconcile routes the dependent back
//     to the planner WITH the upstream change as context; it never drops the work.
//   - NEVER MERGE UNVERIFIED — the ABSORBED key (`verified_ancestor_shas`) is set
//     ONLY after the dependent's own gate+checker+auditor re-ran clean in a real
//     run; the merge-hold + retarget-to-default_branch still govern the merge.
//   - TERMINATES — detection keys off `verified_ancestor_shas` (not the bare build
//     base) AND the in-flight marker, so a sticky `changes_requested` at an
//     unchanged SHA does not re-trigger every walk.

import type { OpenFindingSeverity, ReviewVerdict, SpecLifecycleState } from "./dagLifecycle.js";

// ---- The ancestor-change signal (what the detect step reads) ---------------

/**
 * The promptness an ancestor change demands (§2c "severity gates promptness"):
 *
 *   - `immediate` — an open P0/P1 finding OR a changes-requested verdict on the
 *     ancestor: the chain MUST absorb the change before any merge, so the
 *     re-execution is kicked off NOW (rebuild → re-base → re-run gate/checker/auditor).
 *   - `lazy`      — a non-blocking P2/P3 change: batched into the dependent's next
 *     rebase rather than a prompt re-execution (nothing is silently merged on stale
 *     work, but nothing is needlessly re-run either).
 *   - `none`      — no actionable change: the ancestor head SHA still matches what
 *     the dependent has RE-GATED CLEAN against (a NO-OP — the termination key).
 */
export type PercolationPromptness = "immediate" | "lazy" | "none";

/**
 * The concrete blocking reason that made a percolation `immediate` (for the event).
 *
 *   - `P0` / `P1` / `changes_requested` — a blocking upstream change on an UNMERGED
 *     ancestor (a reviewer push, a new finding, a changes-requested verdict).
 *   - `ancestor_merged` — the ancestor MERGED to `default_branch` (a NEW divergence
 *     axis the SHA-advance rules miss: a squash-merge writes a fresh commit on main
 *     and leaves the ancestor's run branch untouched, so the run-branch head still
 *     equals the verified SHA → no SHA divergence → the descendant would strand on a
 *     squash-induced conflict). This PROACTIVELY re-bases the descendant onto fresh
 *     main, dropping the now-merged ancestor from the speculative stack.
 */
export type ImmediateSeverity = "P0" | "P1" | "changes_requested" | "ancestor_merged";
/** The non-blocking reason that made a percolation `lazy` (for the deferred event). */
export type LazySeverity = "P2" | "P3";

/**
 * One ancestor's CURRENT state vs. what a dependent's run has RE-GATED CLEAN
 * against — the input the pure detect reasons over per ancestor. `verifiedSha` is
 * the SHA the dependent's own gate+checker+auditor last passed against (the
 * `verified_ancestor_shas` entry, or — before any percolation — the build-base SHA
 * the dependent originally integrated + audited against). Detection keys off THIS,
 * never the bare re-base base, so a change is only actionable until it is genuinely
 * re-gated.
 */
export interface AncestorChangeSignal {
  ancestorSpecId: string;
  /** The ancestor head SHA the dependent has RE-GATED CLEAN against (the absorbed key). */
  verifiedSha: string;
  /** The ancestor's CURRENT head SHA (read fresh from the forge each detect). */
  currentSha: string;
  /** The ancestor's current open-finding max severity (the audited verdict). */
  openFindingMaxSeverity: OpenFindingSeverity;
  /** The ancestor's current review verdict, when it reached review. */
  reviewVerdict?: ReviewVerdict;
  /**
   * The review verdict the dependent has ALREADY absorbed for this ancestor at the
   * current verified SHA (the loop-termination guard for a STICKY `changes_requested`
   * that does not advance the SHA). Undefined ⇒ nothing absorbed for a same-SHA
   * verdict yet.
   */
  absorbedReviewVerdict?: ReviewVerdict;
  /**
   * The ancestor MERGED to `default_branch` — a NEW divergence axis (§2c "ancestor
   * merge triggers dependents to auto-rebase onto the new `main`"). A squash-merge
   * writes a fresh commit on main and leaves the ancestor's RUN BRANCH untouched, so
   * the run-branch head still equals the verified SHA and the SHA-advance rules see
   * NO divergence — the descendant would never re-base and would strand on a
   * squash-induced conflict. When `true`, `currentSha`/`mergedSha` are read off the
   * project's `default_branch` HEAD (the merge commit), NOT the stale run branch.
   */
  ancestorMerged?: boolean;
  /**
   * Present when `ancestorMerged`: the `default_branch` HEAD SHA the ancestor merged
   * INTO (the merge commit). This is the absorbed/termination key for a merged
   * ancestor — once `verifiedSha === mergedSha` the merge is absorbed and never
   * re-triggers. Equals `currentSha` when set (kept distinct for clarity at the
   * decision + marker boundary).
   */
  mergedSha?: string;
}

/** The per-ancestor detect decision the coordinator acts on. */
export interface PercolationDecision {
  ancestorSpecId: string;
  promptness: PercolationPromptness;
  fromSha: string;
  toSha: string;
  /** Present when `immediate`: the blocking reason that forced prompt percolation. */
  immediateSeverity?: ImmediateSeverity;
  /** Present when `lazy`: the non-blocking severity batched into the next rebase. */
  lazySeverity?: LazySeverity;
}

/**
 * The PURE per-ancestor DETECT decision (no DB, no I/O, no clock) — the §2c detect +
 * severity→promptness gate, AND the termination key. This is the behavior the
 * conformance suite pins.
 *
 * Rules, in order:
 *   0. The ancestor MERGED to `default_branch` and the dependent has NOT yet
 *      re-based/re-gated against that merge (`verifiedSha !== mergedSha`) ⇒
 *      `immediate`/`ancestor_merged`. This PRECEDES the SHA-advance rules: a
 *      squash-merge leaves the ancestor's run branch untouched, so the SHA-advance
 *      rules would (falsely) see no divergence; this axis catches the merge and
 *      proactively re-bases the descendant onto fresh main BEFORE it strands on a
 *      squash-induced conflict. Once `verifiedSha === mergedSha` the merge is
 *      absorbed and this never re-fires (the termination key).
 *   1. The SHA still matches what the dependent RE-GATED CLEAN against, AND any
 *      changes-requested verdict has ALREADY been absorbed at this SHA ⇒ `none`
 *      (the termination key). A sticky `changes_requested` that was already
 *      re-executed does NOT re-trigger — `absorbedReviewVerdict` records it.
 *   2. A blocking change ⇒ `immediate`: an open P0/P1 finding, OR a NEW
 *      changes-requested (one not yet absorbed at this SHA), OR a SHA advance with a
 *      blocking finding. The chain must absorb it before merging.
 *   3. A non-blocking divergence (SHA changed, only P2/P3/none findings, no
 *      un-absorbed changes-requested) ⇒ `lazy`.
 *
 * `unaudited` is treated as a non-blocking divergence when the SHA advanced (an
 * ancestor that regressed to unaudited but moved its head is a real change to fold
 * in lazily; the moderate THRESHOLD — handled by the walker, not here — separately
 * decides whether the dependent should still speculate at all).
 */
export function decidePercolation(signal: AncestorChangeSignal): PercolationDecision {
  const base = { ancestorSpecId: signal.ancestorSpecId, fromSha: signal.verifiedSha, toSha: signal.currentSha };
  const shaChanged = signal.currentSha !== signal.verifiedSha;
  // A changes-requested verdict is only ACTIONABLE if it has not already been
  // absorbed at this SHA (the sticky-verdict loop guard). When the SHA advances the
  // absorbed-verdict marker no longer applies (it was for the old SHA), so a
  // changes-requested at a new SHA is freshly actionable.
  const changesRequested = signal.reviewVerdict === "changes_requested";
  const newChangesRequested = changesRequested && (shaChanged || signal.absorbedReviewVerdict !== "changes_requested");

  // (0) The ancestor MERGED to default_branch — the NEW divergence axis. A
  //     squash-merge leaves the run branch untouched (so the SHA-advance rules below
  //     see no divergence), but main genuinely moved. Re-base the descendant onto
  //     fresh main NOW, dropping the merged ancestor. Once the dependent re-gated
  //     against the merge commit (`verifiedSha === mergedSha`) it is absorbed and
  //     never re-fires (the termination key). `base.toSha` already carries
  //     `signal.currentSha`, which the read model set to the default_branch head.
  if (signal.ancestorMerged === true && signal.mergedSha !== undefined && signal.verifiedSha !== signal.mergedSha) {
    return { ...base, toSha: signal.mergedSha, promptness: "immediate", immediateSeverity: "ancestor_merged" };
  }

  // (1) Termination: nothing diverged and no UN-ABSORBED review request ⇒ no-op.
  if (!shaChanged && !newChangesRequested) {
    return { ...base, promptness: "none" };
  }

  // (2) Blocking ⇒ immediate. A new changes-requested wins the label (the most
  //     actionable upstream signal); else an open P0/P1 on a diverged ancestor.
  if (newChangesRequested) {
    return { ...base, promptness: "immediate", immediateSeverity: "changes_requested" };
  }
  if (signal.openFindingMaxSeverity === "P0") {
    return { ...base, promptness: "immediate", immediateSeverity: "P0" };
  }
  if (signal.openFindingMaxSeverity === "P1") {
    return { ...base, promptness: "immediate", immediateSeverity: "P1" };
  }

  // (3) A real divergence with only non-blocking findings ⇒ lazy. (Reached only
  //     when shaChanged is true — the !shaChanged + !newChangesRequested case
  //     short-circuited at (1).)
  return { ...base, promptness: "lazy", lazySeverity: signal.openFindingMaxSeverity === "P2" ? "P2" : "P3" };
}

// ---- The in-flight marker + settle ----------------------------------------

/**
 * The IN-FLIGHT percolation marker persisted on the dependent's run
 * `percolation_pending`: the exact signal a re-execution was kicked off for. It
 * is the LOOP GUARD — while it is set the detect skips re-triggering — and it is
 * what the SETTLE phase resolves against when the re-execution terminates.
 */
export interface PercolationPending {
  ancestorSpecId: string;
  /** The ancestor SHA being absorbed (recorded into `verified_ancestor_shas` on settle). */
  toSha: string;
  /** The review verdict being absorbed (the sticky-changes_requested guard). */
  reviewVerdict?: ReviewVerdict;
  /** The re-execution run id kicked off to re-gate the change (observed for settle). */
  reexecRunId: string;
}

/** The settle verdict for an in-flight percolation, derived from the re-exec lifecycle. */
export type SettleVerdict = "absorbed" | "replanned" | "in_flight";

/**
 * The PURE settle decision (no I/O): given the dependent's IN-FLIGHT marker and the
 * lifecycle state of the re-execution run it kicked off, decide whether the change
 * is now ABSORBED (the re-run re-gated clean), routed to REPLAN (the re-run halted /
 * could not reconcile), or still IN-FLIGHT (the re-run is still building). This is
 * what makes the absorbed key advance ONLY after a real clean re-gate.
 *
 *   - the re-exec reached `audited`/`review`/`merged` with NO open P0/P1 AND its
 *     review verdict is NOT `changes_requested` ⇒ `absorbed` (gate+checker+auditor
 *     clean AND the reviewer did not request changes).
 *   - the re-exec is `blocked` (halted/cancelled), OR audited with an open P0/P1, OR
 *     its review verdict is `changes_requested` (a reviewer asked for changes) that
 *     the planner/resolver could not clear ⇒ `replanned` (kept alive, routed back).
 *   - the re-exec is still `building`/`pr_open`/`ci_green` (pre-audit)
 *                                          ⇒ `in_flight` (wait — no re-emit).
 *
 * READING THE REVIEW VERDICT closes the §5 P0 hole (tanren-owns-the-engine.md §5):
 * percolation previously absorbed on `audited`/`review`/`merged` WITHOUT reading the
 * verdict, so a `changes_requested` re-exec could advance `verified_ancestor_shas`
 * and unblock the merge. The verdict is now a FIRST-CLASS settle input:
 * `changes_requested` NEVER absorbs (it is a human signal to route back). An
 * `undefined` verdict (the re-exec has not reached review, or a no-review tier) does
 * NOT block absorption on its own — the lifecycle + severity still govern — so a
 * clean auto-review tier absorbs exactly as before.
 */
export function decideSettle(
  reexecState: SpecLifecycleState,
  reexecSeverity: OpenFindingSeverity,
  reexecReviewVerdict?: ReviewVerdict,
): SettleVerdict {
  if (reexecState === "blocked") {
    return "replanned";
  }
  // Audited-or-beyond is the bar: the dependent's own gate+checker+auditor ran.
  const auditedOrBeyond = reexecState === "audited" || reexecState === "review" || reexecState === "merged";
  if (!auditedOrBeyond) {
    return "in_flight";
  }
  // A clean audit (no open P0/P1) is an absorbed re-gate; an audited run still
  // carrying an open P0/P1 is irreconcilable for now ⇒ keep alive via replan.
  if (reexecSeverity === "P0" || reexecSeverity === "P1") {
    return "replanned";
  }
  // FAIL-CLOSED on the review verdict: a `changes_requested` re-exec NEVER absorbs —
  // the reviewer asked for changes, so the upstream delta is not yet reconciled.
  // Route it back (kept alive), never silently advance the absorbed key (§5 P0).
  if (reexecReviewVerdict === "changes_requested") {
    return "replanned";
  }
  return "absorbed";
}

// ---- The detect read model -------------------------------------------------

/**
 * A dependent speculative run's percolation state. `integratedAncestorShas` is the
 * BUILD BASE (the SHAs the current run is built on); `verifiedAncestorShas` is what
 * its gate+checker+auditor last passed against (the absorbed key the detect uses);
 * `pending` is the in-flight marker (the loop guard). `lifecycleState` /
 * `openFindingMaxSeverity` are the dependent's OWN current run state, used to settle
 * an in-flight marker.
 */
export interface SpeculativeDependent {
  specId: string;
  runId: string;
  /**
   * The dynamic base (integration branch) the dependent's PR is built on. NULL for a
   * §2c "ancestor-merged → non-speculative re-base" (every ancestor merged ⇒ the
   * dependent re-based onto plain `default_branch`); such a run is still loaded — it
   * carries an in-flight percolation marker the settle must resolve (the termination key).
   */
  speculativeBase: string | null;
  /** The per-ancestor SHAs the current run is BUILT ON (the re-base base). */
  integratedAncestorShas: Record<string, string>;
  /** The per-ancestor SHAs the dependent RE-GATED CLEAN against (the absorbed key). */
  verifiedAncestorShas: Record<string, string>;
  /**
   * The review verdict the dependent has ALREADY absorbed per ancestor at its
   * verified SHA (the sticky-changes_requested loop guard). Keyed by ancestor spec id.
   */
  absorbedReviewVerdicts?: Record<string, ReviewVerdict>;
  /** The in-flight percolation marker, when a re-execution is mid-absorb. */
  pending?: PercolationPending;
  /** The dependent's OWN current lifecycle state (for settling an in-flight marker). */
  lifecycleState: SpecLifecycleState;
  /** The dependent's OWN current open-finding max severity (for settling). */
  openFindingMaxSeverity: OpenFindingSeverity;
  /**
   * The dependent's OWN current review verdict, when its re-execution reached review
   * (the §5 P0 settle input). `changes_requested` BLOCKS absorption — percolation
   * must never advance the verified SHA on a re-exec the reviewer asked to change.
   * Undefined ⇒ the re-exec has not reached review / a no-review tier (the lifecycle
   * + severity still govern; absorption is not blocked on the verdict alone).
   */
  reviewVerdict?: ReviewVerdict;
}

/**
 * Reads, under RLS, the project's IN-FLIGHT SPECULATIVE dependents (runs carrying a
 * `speculative_base` + a non-empty `integrated_ancestor_shas` map) together with
 * each ancestor's CURRENT head SHA + lifecycle severity — the {@link AncestorChangeSignal}s
 * `decidePercolation` consumes — and the dependent's own lifecycle (for settle). DAG
 * state is the source of truth: read fresh each detect, org-scoped. NEVER mutates.
 */
export interface PercolationReadModel {
  /** The in-flight speculative dependents whose verified SHAs may have diverged. */
  loadSpeculativeDependents(projectId: string): Promise<SpeculativeDependent[]>;
  /**
   * The CURRENT per-ancestor change signals for one dependent (current head SHA +
   * the ancestor's open-finding max severity + review verdict, zipped against the
   * dependent's VERIFIED SHAs + absorbed-verdict markers).
   */
  loadAncestorSignals(input: { projectId: string; dependent: SpeculativeDependent }): Promise<AncestorChangeSignal[]>;
}

// ---- The kick-off operation (rebuild + re-base + re-execute) ----------------

/**
 * The outcome of KICKING OFF a percolation for ONE (dependent, ancestor-change).
 * `reexecuting`: the integration was rebuilt against the ancestor's new state, the
 * dependent re-based onto it, and a real re-execution enqueued — its gate + checker
 * + auditor will run; the change is NOT yet absorbed (it settles when that run
 * terminates clean). `held`: the rebuild surfaced an ancestor-vs-ancestor conflict
 * (routed to the conflict resolver as in the merge-hold) — retried next walk; the work untouched.
 */
export interface PercolationKickOffOutcome {
  result: "reexecuting" | "held";
  ancestorSpecId: string;
  /** On `reexecuting`: the re-execution run id (recorded in the in-flight marker). */
  reexecRunId?: string;
  /** On `held`: the ancestor-vs-ancestor conflict detail. */
  reason?: string;
}

/**
 * Kicks off the §2c chain re-integration for ONE (dependent, ancestor-change):
 *   1. Rebuild the dependent's speculative integration against the ancestor's NEW
 *      state (reuse the SpeculativeIntegrator). An A-vs-other conflict ⇒
 *      `held` (routed to the conflict resolver, retried next walk).
 *   2. Re-base the dependent onto the rebuilt integration (update `speculative_base`
 *      + `integrated_ancestor_shas`), keeping the dependent's OWN branch/work as the
 *      base — never reset/discarded.
 *   3. Re-execute the dependent through a REAL run (the DagWalker createQueuedRunFromSpec
 *      path) so its gate + checker + auditor genuinely re-run against the percolated
 *      change (the planner re-plans / the upstream-change resolver reconciles a
 *      break). Record the in-flight marker (so the settle phase resolves it and a
 *      sticky signal does not re-trigger). Returns `reexecuting` with the run id.
 * It does NOT record the absorbed SHA — that happens on SETTLE, only after the
 * re-execution re-gated clean (NEVER merge unverified).
 */
export interface PercolationKickOff {
  kickOff(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    /**
     * The ancestor spec ids that have MERGED to `default_branch` (lifecycle
     * `merged`). The kick-off DROPS these from the speculative stack: the rebuilt
     * integration stacks only the UNMERGED ancestors (a merged ancestor's content
     * arrives via fresh main, since the integrator resets the ephemeral ref to
     * `default_branch` first). When EVERY ancestor has merged the re-base is onto
     * plain `default_branch` and the re-execution is genuinely NON-speculative
     * (`speculative_base` cleared to NULL) — a real run against main.
     */
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<PercolationKickOffOutcome>;
}

/**
 * Settles an in-flight percolation once its re-execution terminated. `absorb`
 * advances `verified_ancestor_shas` (the termination key) + clears the marker;
 * `replan` routes the dependent back to the planner WITH the change as context +
 * clears the marker. Both are persisted under RLS by the production impl.
 */
export interface PercolationSettler {
  /** Record the re-gated-clean ancestor SHA + the absorbed verdict; clear the marker. */
  absorb(input: { projectId: string; dependent: SpeculativeDependent; pending: PercolationPending }): Promise<void>;
  /** Route the dependent back to the planner WITH the upstream change; clear the marker. */
  replan(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    pending: PercolationPending;
    reason: string;
  }): Promise<void>;
}

// ---- The chain event emitter ----------------------------------------------

/** Emits the §2c percolation visibility events (the production impl is org-scoped). */
export interface PercolationEventEmitter {
  emitPercolating(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    fromAncestorSha: string;
    toAncestorSha: string;
    severity: ImmediateSeverity;
  }): Promise<void>;
  emitPercolated(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    integratedAncestorSha: string;
    viaResolver: boolean;
  }): Promise<void>;
  emitPercolationDeferred(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    pendingAncestorSha: string;
    severity: LazySeverity;
  }): Promise<void>;
  emitPercolationReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void>;
}
