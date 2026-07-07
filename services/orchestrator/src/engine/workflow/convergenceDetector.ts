// THE ONE INTELLIGENT NON-CONVERGENCE DETECTOR (apex v35 — no hardcoded attempt caps).
//
// THE BINDING PRINCIPLE (product owner, verbatim): "There should NEVER be a hardcoded
// number of attempts for ANYTHING. The ONLY thing that should cause escalation is an
// intelligent detection that we aren't converging — which does NOT mean lack of
// advancement (slow / many-tries is fine), it means we aren't making PROGRESS (the same
// failure repeating with no real change)."
//
// So EVERY convergence loop (the run-finalize re-drive, the base-shift / conflict
// re-plan, the batch-gate rework, the fragment-authoring writer→validate loop, the
// spec-implementation loop) continues UNBOUNDED while it is making PROGRESS, and escalates to a genuine
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
 *   - the fragment-authoring writer→validate loop (F2): `failureSignature` = the
 *     validator's rejection code; `workSignature` = the writer's produced fragment body hash;
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
 * The structural read of the latest attempt against the prior history:
 *   - `progress`     — the latest attempt advanced (a different failure, different work, OR
 *                      a smaller magnitude than the state it would otherwise repeat).
 *                      CONTINUE, unbounded — never escalate.
 *   - `fixed_point`  — the latest attempt is a PROVEN dead-end: either it reproduced the
 *                      IMMEDIATELY-prior attempt's observable work BYTE-IDENTICALLY (no new
 *                      information at all), or its state RECURS an earlier (non-immediate)
 *                      attempt in the trailing window with no net magnitude decrease since
 *                      (an A→B→A→B / A→A→A oscillation — a cycle, not forward motion). The
 *                      suspected dead-end where the intelligent escalation judgment is consulted.
 *   - `first`        — there is no prior attempt to compare against (always CONTINUE).
 */
export type StructuralProgress = "progress" | "fixed_point" | "first";

/**
 * The trailing window (counting back from the latest attempt) the CYCLE detection scans for
 * a recurrence of the latest state. This is NOT an attempt cap and NOT a `K`: the loop
 * re-drives UNBOUNDED while it makes progress regardless of length; the window only bounds
 * how far back a RECURRENCE counts as evidence of a cycle (so an ancient state visited once,
 * long before sustained later progress, does not spuriously re-trigger). A monotonically
 * shrinking-magnitude trajectory (1000 → 500 → 100 → 1) NEVER trips it — every recurrence
 * has a net magnitude decrease since, so it always reads as progress, no matter the window.
 */
const CYCLE_WINDOW = 8;

/**
 * Optional tuning the watchdog call site uses to WIDEN the immediate-neighbor identity check
 * (`reproducedIdenticalWork`). The default semantics — a single byte-identical repeat is
 * already a fixed point — are correct for the writer-spec rework loop (the agent demonstrably
 * produced identical observable work, no new information). They are TOO TIGHT for the
 * activity-watchdog use, where the "work signature" is a fold of the recent output tail + a
 * workspace probe sampled on a poll cadence (apex v50: a legitimate writer running
 * `pnpm install` is silent at the codex layer while the bash subprocess runs, AND the
 * workspace count+bytes probe can read identical mid-IO-burst across a single 15s tick).
 * Raising the streak floor at THAT call site (the only one that opts in) requires N
 * consecutive identical immediate neighbors before declaring a wedge — still progress /
 * sign-of-life, just a more honest floor for tool-invoking agent execs. The cycle-detection
 * branch is independent (and unaffected): it already requires a recurrence across an
 * intervening attempt.
 */
export interface StructuralProgressOptions {
  /**
   * Minimum count of CONSECUTIVE identical immediate-neighbor pairs at the trailing edge of
   * the history required to fire the `reproducedIdenticalWork` (immediate-neighbor identity)
   * branch of {@link assessStructuralProgress}. Default `1` — the existing semantics, where a
   * single byte-identical repeat is a fixed point. The activity watchdog passes `2` so a
   * single mid-IO-burst identical probe is not enough to declare a wedge.
   */
  minNonAdvancingRepeats?: number;
}

/**
 * Assess STRUCTURAL progress of the latest attempt against the prior history. PURE (no I/O,
 * no clock) so it is reproducible + unit-testable. The history is oldest→newest; the latest
 * attempt is the last element. The loop is making PROGRESS — and so CONTINUES, UNBOUNDED —
 * unless the latest attempt is a PROVEN dead-end:
 *
 *   - PROVEN-IDENTICAL IMMEDIATE WORK: it reproduced the immediately-prior attempt's
 *     observable work BYTE-IDENTICALLY (same failure signature, both work signatures observed
 *     and equal, no magnitude decrease) — the agent produced the identical output and got the
 *     identical failure, with literally no new information. A single such repeat is already a
 *     fixed point (there is nothing left to observe). The activity-watchdog call site widens
 *     this to N consecutive identical neighbors via `minNonAdvancingRepeats` (default 1).
 *   - CYCLE / OSCILLATION: the latest state RECURS an EARLIER (non-immediate) attempt within
 *     the trailing window with NO net magnitude decrease since that earlier occurrence. This
 *     catches A→B→A→B (alternating signatures) and 5→4→5→4 (oscillating magnitude) — a loop
 *     that revisits a state it has already been in WITHOUT having gotten closer is cycling,
 *     not progressing, even though each immediate neighbor differs.
 *
 * A different failure, different produced work, OR a strictly smaller magnitude than every
 * prior occurrence of the same state is PROGRESS — no matter how many attempts preceded it.
 * Crucially, the 1000 → 500 → 100 → 1 trajectory is PROGRESS at every step (each value is a
 * NET magnitude decrease since any prior occurrence), so it is NEVER flagged — the windowed
 * look-back is CYCLE detection, not an attempt cap.
 *
 * Returns `first` for an empty/single-element history (nothing to compare → CONTINUE).
 */
export function assessStructuralProgress(
  history: ReadonlyArray<AttemptSignature>,
  options: StructuralProgressOptions = {},
): StructuralProgress {
  if (history.length < 2) return "first";
  const latest = history.at(-1);
  const prior = history.at(-2);
  if (latest === undefined || prior === undefined) return "first";
  // The minimum trailing identical-neighbor streak the immediate-neighbor identity branch
  // requires. Default 1 preserves the writer-spec rework-loop semantics; the activity
  // watchdog passes 2 (so a single 15s probe of identical signature mid-IO-burst is not yet
  // a wedge). A value < 1 is meaningless (no streak threshold can fire on 0 neighbors); we
  // floor it to 1 so the default behavior is preserved.
  const minRepeats = Math.max(1, options.minNonAdvancingRepeats ?? 1);
  // (1) Proven-identical IMMEDIATE work: the agent reproduced byte-identical observable output
  // and got the identical failure with no magnitude reduction — a dead-end on the first repeat
  // (default) or once the trailing streak reaches `minRepeats` consecutive identical neighbors
  // (the activity-watchdog call site). The streak is read backwards from the latest pair.
  if (reproducedIdenticalWork(prior, latest) && nonAdvancingNeighborStreak(history) >= minRepeats) {
    return "fixed_point";
  }
  // (2) Cycle / oscillation: the latest state recurs an EARLIER (non-immediate) attempt with no
  // net magnitude decrease since AND no new state explored in between — a loop revisiting states
  // it has already been in without getting closer. A single immediate repeat alone is NOT this
  // (so a transient identical failure that recurs once — no observable work — is still progress,
  // not an instant escalation), and a loop that found a NEW state since is still exploring.
  if (isCycle(history)) return "fixed_point";
  return "progress";
}

/**
 * The length of the trailing run of CONSECUTIVE identical immediate-neighbor pairs ending at
 * the latest attempt — i.e. how many of the most recent pairs satisfy
 * `reproducedIdenticalWork`. A pair that genuinely advances (a different failure / different
 * observed work / a magnitude decrease) breaks the run. Used ONLY by the streak-floor branch
 * of {@link assessStructuralProgress}; PURE (no I/O, no clock). Returns 0 when the trailing
 * neighbor pair is itself advancing.
 */
function nonAdvancingNeighborStreak(history: ReadonlyArray<AttemptSignature>): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 1; i -= 1) {
    const latest = history.at(i);
    const prior = history.at(i - 1);
    if (latest === undefined || prior === undefined) break;
    if (!reproducedIdenticalWork(prior, latest)) break;
    streak += 1;
  }
  return streak;
}

/**
 * Did `latest` reproduce `prior`'s observable work BYTE-IDENTICALLY with no forward motion?
 * Same failure signature, BOTH work signatures observed and equal, and no magnitude decrease
 * (a non-shrinking magnitude or no magnitude on either). This is the ONLY immediate-neighbor
 * fixed point: the agent demonstrably produced the identical output, so there is no new
 * information to act on even on the first repeat. Without an OBSERVED identical work signature,
 * a single immediate repeat is NOT proof of a dead-end (it may be a transient recurrence) —
 * that is left to the cycle detection (a recurrence beyond the immediate neighbor).
 */
function reproducedIdenticalWork(prior: AttemptSignature, latest: AttemptSignature): boolean {
  if (latest.failureSignature !== prior.failureSignature) return false;
  if (latest.workSignature === undefined || prior.workSignature === undefined) return false;
  if (latest.workSignature !== prior.workSignature) return false;
  // Identical observed work + identical failure: a magnitude decrease would still be progress
  // (the same diff somehow retired errors), but identical work cannot — guard it anyway.
  return !shrankMagnitude(prior, latest);
}

/** A strict magnitude decrease (trajectory progress) — only when both magnitudes are known. */
function shrankMagnitude(from: AttemptSignature, to: AttemptSignature): boolean {
  return from.magnitude !== undefined && to.magnitude !== undefined && to.magnitude < from.magnitude;
}

/**
 * Is the LATEST attempt a CYCLE — back in a state it has already been in, with the loop merely
 * revisiting already-seen states (not exploring) and no net forward motion? The latest is a
 * cycle iff there is an EARLIER (non-immediate) occurrence `E` of the latest's state within the
 * trailing `CYCLE_WINDOW` such that BOTH:
 *
 *   (a) NO NET MAGNITUDE DECREASE since `E` — `latest.magnitude` is not strictly below `E`'s
 *       (so a shrinking 1000 → 500 → 100 → 1 trajectory is ALWAYS progress, never a cycle), AND
 *   (b) NO NEW STATE appeared after `E` — every attempt strictly after `E` is a state already
 *       seen at-or-before `E`. If a brand-NEW state showed up since the loop was last in this
 *       state, the loop is still EXPLORING (progress: it found something new and circled back),
 *       not stuck in an oscillation.
 *
 * Requiring a NON-IMMEDIATE recurrence means a single transient repeat (A→A with no observed
 * work) is NOT yet a cycle — only A→A→A or A→B→A→B (the state recurring across an intervening
 * attempt) is. Two attempts are the SAME STATE when their failure signatures match AND — when
 * both observed their work — their work signatures match (an unobserved work signature collapses
 * the state onto the failure axis). The window bounds how far back a recurrence counts, so it is
 * cycle detection (a revisited-state structure), NOT an attempt cap.
 */
function isCycle(history: ReadonlyArray<AttemptSignature>): boolean {
  const latest = history.at(-1);
  if (latest === undefined) return false;
  const windowFloor = Math.max(0, history.length - CYCLE_WINDOW);
  // Scan NON-immediate earlier attempts (skip the immediate predecessor at -2 — that is the
  // single-repeat case handled by the observed-identical-work check), newest first, in-window.
  for (let earlierIdx = history.length - 3; earlierIdx >= windowFloor; earlierIdx -= 1) {
    const earlier = history.at(earlierIdx);
    if (earlier === undefined) continue;
    if (!sameState(earlier, latest)) continue;
    // (a) trajectory: the latest must not have net-shrunk its magnitude since `earlier`.
    if (shrankMagnitude(earlier, latest)) continue;
    // (b) exploration: no attempt after `earlierIdx` may be a state unseen at-or-before it.
    if (!newStateAppearedAfter(history, earlierIdx, windowFloor)) return true;
  }
  return false;
}

/**
 * Did a brand-NEW state (one not seen at any in-window index ≤ `pivot`) appear at any index
 * strictly after `pivot`? A new state means the loop is still EXPLORING since it was last at the
 * `pivot` state — so the recurrence is NOT a cycle. (Scanned within the trailing window only.)
 */
function newStateAppearedAfter(history: ReadonlyArray<AttemptSignature>, pivot: number, windowFloor: number): boolean {
  for (let j = pivot + 1; j < history.length; j += 1) {
    const candidate = history.at(j);
    if (candidate === undefined) continue;
    let seenAtOrBeforePivot = false;
    for (let k = windowFloor; k <= pivot; k += 1) {
      const earlier = history.at(k);
      if (earlier !== undefined && sameState(earlier, candidate)) {
        seenAtOrBeforePivot = true;
        break;
      }
    }
    if (!seenAtOrBeforePivot) return true;
  }
  return false;
}

/**
 * Are two attempts the SAME STATE? Same failure signature, and — only when BOTH observed their
 * work — the same work signature (a missing work signature on either side cannot tell them
 * apart, so the state is keyed on the failure signature alone). Magnitude is NOT part of state
 * identity; it is the trajectory the recurrence check measures net progress against.
 */
function sameState(a: AttemptSignature, b: AttemptSignature): boolean {
  if (a.failureSignature !== b.failureSignature) return false;
  if (a.workSignature !== undefined && b.workSignature !== undefined) {
    return a.workSignature === b.workSignature;
  }
  return true;
}

/** Did `latest` advance over `prior` on ANY observable axis (failure / work / magnitude)? Used
 * only by {@link fixedPointStreak} as a per-neighbor diagnostic; the fixed-point DECISION is
 * {@link assessStructuralProgress} (which also detects cycles, not just neighbor identity). */
function madeProgress(prior: AttemptSignature, latest: AttemptSignature): boolean {
  if (latest.failureSignature !== prior.failureSignature) return true;
  if (
    latest.workSignature !== undefined &&
    prior.workSignature !== undefined &&
    latest.workSignature !== prior.workSignature
  ) {
    return true;
  }
  return shrankMagnitude(prior, latest);
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
