// THE ONE INTELLIGENT NON-CONVERGENCE DETECTOR (apex v35 — no hardcoded attempt caps).
//
// THE BINDING PRINCIPLE (product owner, verbatim): "There should NEVER be a hardcoded
// number of attempts for ANYTHING. The ONLY thing that should cause escalation is an
// intelligent detection that we aren't converging — which does NOT mean lack of
// advancement (slow / many-tries is fine), it means we aren't making PROGRESS (the same
// failure repeating with no real change)."
//
// So EVERY convergence loop (the run-finalize re-drive, the base-shift / conflict
// re-plan, the batch-gate rework, the template-build recovery, the spec-implementation
// loop) continues UNBOUNDED while it is making PROGRESS, and escalates to a genuine
// human-decision ONLY when it is intelligently detected to be genuinely STUCK. There is
// NO `K`, NO `MAX_*`, NO fixed budget — anywhere. This module is the single decision the
// scattered counters collapse into.
//
// TWO-STAGE DECISION (cheap structural gate, then the intelligent escalation judgment):
//
//   1. STRUCTURAL PROGRESS (cheap, the common case). An attempt made PROGRESS over the
//      prior one if ANY of:
//        - its failure SIGNATURE changed (a different error / tier / step / root cause), OR
//        - the WORK it produced changed (a different result tree / diff / head), OR
//        - its MAGNITUDE shrank (fewer errors, a smaller defect, more criteria passing —
//          the 1000 → 500 → 100 → 1 trajectory: still failing, but genuinely converging).
//      While there is progress → CONTINUE, UNBOUNDED. Advancement / slowness / many tries
//      NEVER escalate. This is the trajectory-aware signal: getting SMALLER / closer to
//      resolved is progress even when every attempt still "fails".
//
//   2. SUSPECTED FIXED POINT → the INTELLIGENT escalation judgment. Only when an attempt
//      is at a suspected FIXED POINT — the SAME failure signature AND the SAME work output
//      AND no magnitude reduction (the agent is producing identical output and getting the
//      identical failure, with no new information) — do we even CONSIDER escalating. At
//      that point the decision is NOT a count: it is the bar "would a human do anything
//      other than say 'keep going, you're almost there'?" Escalate ONLY when human input
//      would genuinely CHANGE the outcome (an ambiguous requirement, a missing
//      resource/credential, a genuine product/architecture choice, or a demonstrably
//      exhausted dead-end where the agent has stopped making ANY progress AND has no new
//      approach). The caller supplies that judgment via an agent-assessed verdict when the
//      answerer infra is available (the spec loop), or — when it is not (a durable
//      re-drive / re-plan whose escalation point is a bare DB-driven decision) — the
//      rigorous fixed-point rule stands in: escalate ONLY once the loop is PROVABLY at a
//      fixed point (an identical failure AND identical work, repeated, with no new
//      information), with a specific human-actionable diagnosis. Escalation is RARE.

/**
 * The distilled signature of ONE convergence attempt — the inputs the structural progress
 * read reasons over. Every loop maps its own attempt shape onto this:
 *   - the run-finalize re-drive: `failureSignature` = the classified failure code(+stage);
 *     `workSignature` = the produced head/branch sha (when known);
 *   - the base-shift / conflict re-plan: `failureSignature` = the conflict's root-cause
 *     identity; `workSignature` = the re-planned branch head;
 *   - the batch-gate rework: `failureSignature` = the failing integrated-gate tier/step;
 *     `workSignature` = the reworked head;
 *   - the template-build recovery: `failureSignature` = the stranded-spec set;
 *     `magnitude` = the count of NOT-yet-merged specs (shrinks as the build converges);
 *   - the spec loop: `failureSignature` = the blocking root-cause id; `magnitude` = the
 *     total P-score (shrinks as findings are retired).
 */
export interface AttemptSignature {
  /**
   * The STABLE identity of WHY this attempt failed — a root-cause key, NOT surface text
   * (so "the same vitest failure" is recognized across attempts by identity, not wording).
   * A CHANGED signature is progress (a different failure = the loop moved the problem).
   */
  failureSignature: string;
  /**
   * The STABLE identity of WHAT this attempt produced — a result-tree / diff / head sha.
   * `undefined` when the loop cannot observe its work output (then progress keys off the
   * failure signature + magnitude alone). CHANGED work is progress (the agent did
   * something different) even if it still fails the same way.
   */
  workSignature?: string;
  /**
   * An optional NON-NEGATIVE magnitude of the remaining problem (error count, defect size,
   * unmet-criteria count, total P-score, not-yet-merged-spec count). SHRINKING magnitude
   * is progress (the 1000 → 500 → 100 trajectory) even at an unchanged failure signature.
   * Omit when the loop has no meaningful magnitude.
   */
  magnitude?: number;
}

/**
 * The structural read of the latest attempt vs the immediately-prior one:
 *   - `progress`     — the latest attempt advanced (different failure, different work, OR
 *                      smaller magnitude). CONTINUE, unbounded — never escalate.
 *   - `fixed_point`  — the latest attempt is identical to the prior on every observable
 *                      axis (same failure, same work, non-shrinking magnitude): a suspected
 *                      dead-end where the intelligent escalation judgment is consulted.
 *   - `first`        — there is no prior attempt to compare against (always CONTINUE).
 */
export type StructuralProgress = "progress" | "fixed_point" | "first";

/**
 * Assess STRUCTURAL progress of the latest attempt against the FULL prior history. PURE
 * (no I/O, no clock) so it is reproducible + unit-testable. The history is oldest→newest;
 * the latest attempt is the last element. Progress is judged against the IMMEDIATELY prior
 * attempt — a single advancing step (smaller magnitude, a different failure, or different
 * work) is progress, no matter how many attempts preceded it. Only when the latest is
 * indistinguishable from the prior is it a suspected fixed point.
 *
 * Returns `first` for an empty/single-element history (nothing to compare → CONTINUE).
 */
export function assessStructuralProgress(history: ReadonlyArray<AttemptSignature>): StructuralProgress {
  if (history.length < 2) return "first";
  const latest = history.at(-1);
  const prior = history.at(-2);
  if (latest === undefined || prior === undefined) return "first";
  return madeProgress(prior, latest) ? "progress" : "fixed_point";
}

/** Did `latest` advance over `prior` on ANY observable axis (failure / work / magnitude)? */
function madeProgress(prior: AttemptSignature, latest: AttemptSignature): boolean {
  // A different failure signature = the loop moved the problem (progress).
  if (latest.failureSignature !== prior.failureSignature) return true;
  // Different produced work = the agent did something different (progress), even at the
  // same failure. Only counts when BOTH attempts observed their work (else inconclusive).
  if (
    latest.workSignature !== undefined &&
    prior.workSignature !== undefined &&
    latest.workSignature !== prior.workSignature
  ) {
    return true;
  }
  // SHRINKING magnitude = trajectory progress (the 1000 → 500 → 100 case): still failing
  // the same way, but genuinely closer to resolved. Only counts when both are known.
  if (latest.magnitude !== undefined && prior.magnitude !== undefined && latest.magnitude < prior.magnitude) {
    return true;
  }
  // No observable advance on any axis: a suspected fixed point.
  return false;
}

/**
 * How LONG has the loop been at a fixed point? Counts the CONSECUTIVE TRAILING attempts
 * (ending at the latest) that each made NO progress over their predecessor — i.e. the
 * length of the current stuck streak. NOT a cap: it is a DIAGNOSTIC the escalation judgment
 * + the timeline use to describe "the agent has produced identical output N times in a
 * row". A single progressing step anywhere resets the streak. (0 when the latest itself is
 * progress / first.)
 */
export function fixedPointStreak(history: ReadonlyArray<AttemptSignature>): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    const latest = history.at(i);
    const prior = history.at(i - 1);
    if (latest === undefined || prior === undefined) break;
    if (madeProgress(prior, latest)) break;
    streak += 1;
  }
  return streak;
}

/**
 * The escalation JUDGMENT the caller supplies at a suspected fixed point — the intelligent
 * "would a human add value beyond 'keep going'?" decision:
 *   - `keep_going` — a human would just say "keep going, you're almost there": the loop
 *     CONTINUES (nudged with new context) even though THIS attempt did not visibly advance.
 *   - `escalate`   — human input would genuinely change the outcome (a real
 *     decision/blocker the agent fundamentally cannot resolve, or a demonstrably-exhausted
 *     dead-end): escalate to `needs_attention` with `reason`.
 * `reason` is REQUIRED on `escalate` — a specific, human-actionable diagnosis (never a bare
 * "stuck"). When the caller has no agent to ask, `fixedPointRuleJudgment` provides the
 * rigorous principled stand-in.
 */
export type EscalationJudgment = { verdict: "keep_going" } | { verdict: "escalate"; reason: string };

/**
 * THE decision. Given the attempt history (oldest→newest, the latest included) + a
 * `judge` that renders the intelligent escalation verdict at a suspected fixed point,
 * return whether the loop CONTINUEs or ESCALATEs. The `judge` is invoked ONLY at a fixed
 * point (so the expensive agent assessment runs rarely — never on a progressing loop).
 *
 *   - `continue` — the loop runs again (progress, or the judge said "keep going").
 *   - `escalate` — a genuine `needs_attention` with the judge's human-actionable reason.
 *
 * PURE wrt the structural read; the `judge` may be async (an answerer call) — so this is
 * async. While there is progress, `judge` is never called and the loop is UNBOUNDED.
 */
export async function decideConvergence(
  history: ReadonlyArray<AttemptSignature>,
  judge: (history: ReadonlyArray<AttemptSignature>) => Promise<EscalationJudgment> | EscalationJudgment,
): Promise<{ decision: "continue" } | { decision: "escalate"; reason: string }> {
  const structural = assessStructuralProgress(history);
  if (structural !== "fixed_point") {
    // Progress (or the first attempt): CONTINUE, unbounded — never even ask the judge.
    return { decision: "continue" };
  }
  // A suspected fixed point: consult the intelligent escalation judgment. ONLY a genuine
  // dead-end / human-decision escalates; otherwise keep going (nudge with new context).
  const judgment = await judge(history);
  if (judgment.verdict === "escalate") {
    return { decision: "escalate", reason: judgment.reason };
  }
  return { decision: "continue" };
}

/**
 * The PRINCIPLED fixed-point escalation rule — the rigorous stand-in for the agent-assessed
 * judgment when the caller has NO answerer to ask at the escalation point (the durable
 * re-drive / re-plan / rework / recovery loops, whose escalation is a bare DB-driven
 * decision). It escalates ONLY at a PROVABLE fixed point: the loop has produced an
 * IDENTICAL failure AND identical work (no new information) for the latest attempt — i.e.
 * `assessStructuralProgress` already returned `fixed_point` (the caller only invokes this
 * there). It does NOT count attempts; the fixed-point detection itself is the loop-breaker.
 *
 * The returned `reason` is a specific, human-actionable diagnosis built from the loop's own
 * failure description — never a bare "stuck". `describeDeadEnd` renders the loop-specific
 * "this same X recurred with identical work — a human must Y" message.
 */
export function fixedPointRuleJudgment(
  history: ReadonlyArray<AttemptSignature>,
  describeDeadEnd: () => string,
): EscalationJudgment {
  // The caller invokes this only at a fixed point; the streak length enriches the diagnosis
  // (how many identical attempts), but is NEVER a threshold — a fixed point of ONE identical
  // repeat is already a proven dead-end under this rule.
  void fixedPointStreak(history);
  return { verdict: "escalate", reason: describeDeadEnd() };
}
