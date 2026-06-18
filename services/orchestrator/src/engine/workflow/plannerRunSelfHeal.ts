// The planner-loop's SELF-HEAL re-entry decisions, split out of plannerRunFinalize.ts to keep
// that file under the 500-line architecture cap. Both the pre_merge-gate self-heal
// (`applyFailedMergeGate`) and the review-verdict re-entry (`applyReviewVerdict`) route their
// escalation through the SHARED magnitude-aware convergence detector (`atGateFixedPoint`): a
// CHANGED failure OR a SHRINKING error/requested-change count is PROGRESS (re-work, UNBOUNDED),
// and only a GENUINE fixed point (the same failure with no magnitude decrease) halts. NO count.

import type { EventName, EventPayload } from "../events/index.js";
import type { GateOutcome } from "./gate/index.js";
import {
  atGateFixedPoint,
  type GateAttempt,
  gateErrorSignature,
  mergeGateRejection,
  outputMagnitude,
} from "./reviewMerge/index.js";
import type { PlannerRejectionFeedback } from "./planner/planner.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";
import { type FinalizeRunState, finalizeNonPassOutcome, setSpecStatus } from "./plannerRunFinalize.js";

/** The merge stage's decision for a failed `pre_merge` gate: re-author (progress) or halt (fixed point). */
export type MergeGateSelfHealDecision =
  // Re-enter the writer with the carried rejection. The error CHANGED — OR its count SHRANK (a
  // converging trajectory) — so this is progress: keep going, UNBOUNDED. The `attempt` (signature
  // + magnitude) is recorded so the next detector tells a shrinking trajectory (progress) from a
  // genuine fixed point (same error, no magnitude decrease).
  | { kind: "rework"; rejection: PlannerRejectionFeedback; attempt: GateAttempt }
  // A FIXED POINT: the same error recurs with no shrinking count; halt LOUD.
  | { kind: "halt" };

/**
 * The convergence ATTEMPT (signature + magnitude) of a failed gate outcome. The SIGNATURE is the
 * stable `tier:step:output` identity; the MAGNITUDE is the stack-agnostic count of non-empty
 * diagnostic lines in the failing step's output (`outputMagnitude`) — a writer fixing one failure
 * after another shrinks it even at an UNCHANGED signature, so the trajectory reads as PROGRESS
 * (the single-step-fixed-point bug this fixes).
 */
export function gateOutcomeAttempt(gate: Extract<GateOutcome, { passed: false }>): GateAttempt {
  const { failure } = gate;
  const failedStep = failure.steps.find((step) => step.name === failure.failedStep) ?? failure.steps.at(-1);
  const magnitude = outputMagnitude(failedStep?.outputTail ?? "");
  return {
    signature: gateErrorSignature(`${failure.tier}:${failure.failedStep}:${failedStep?.outputTail ?? ""}`),
    ...(magnitude !== undefined && { magnitude }),
  };
}

/**
 * SELF-HEAL (apex v35 — no count budget): decide what a FAILED `pre_merge` gate does, via the
 * shared `convergenceDetector`. While the gate error keeps CHANGING — OR its error count keeps
 * SHRINKING (a 50 → 20 → 5 trajectory at the SAME `tier:step`, which a bare signature read
 * mistook for a fixed point) — the writer is making PROGRESS, so `rework` (re-enter the writer
 * with the `mergeGateRejection` steering), UNBOUNDED. Only at a GENUINE FIXED POINT (the SAME
 * error recurs with NO shrinking count) return `halt` (the run ends LOUD). `priorAttempts` are
 * the signatures + magnitudes re-worked against (oldest→newest); the magnitude carries the
 * trajectory across iterations. NO count — `atGateFixedPoint` is the loop-breaker.
 */
export async function mergeGateSelfHeal(
  gate: Extract<GateOutcome, { passed: false }>,
  priorAttempts: ReadonlyArray<GateAttempt>,
): Promise<MergeGateSelfHealDecision> {
  const attempt = gateOutcomeAttempt(gate);
  if (await atGateFixedPoint(priorAttempts, attempt)) {
    return { kind: "halt" };
  }
  return { kind: "rework", rejection: mergeGateRejection(gate), attempt };
}

/**
 * Mutable self-heal STATE for the pre_merge gate (apex v35 — no count budget). Records the
 * SIGNATURE + remaining-problem MAGNITUDE of each gate failure the writer was sent back to
 * fix, so the shared `convergenceDetector` distinguishes a changing gate error OR a shrinking
 * error count (a 50 → 20 → 5 trajectory — keep re-working, UNBOUNDED) from a genuine FIXED
 * POINT (the SAME error recurs with no magnitude decrease — escalate). `used` is observability,
 * not a bound.
 */
export interface MergeGateBudget {
  used: number;
  /** The gate-failure attempts (signature + magnitude) re-worked against (oldest→newest). */
  attempts: GateAttempt[];
}

/**
 * SELF-HEAL (apex v34): apply the merge stage's decision for a FAILED `pre_merge` gate (the
 * convergence call is `mergeGateSelfHeal`). `rework`: record the attempt (signature + magnitude),
 * seed the carried steering (the failing tier/step/OUTPUT), return the spec to `in_flight`, signal
 * `"rework"`. `halt` (a fixed point): finalize the run halted (the spec RE-DRIVES), signal `"halt"`.
 * Owns the state + lifecycle writes so the loop branches on the single returned signal.
 */
export async function applyFailedMergeGate(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  decision: { kind: "rework"; rejection: PlannerRejectionFeedback; attempt: GateAttempt } | { kind: "halt" },
  seedRejections: PlannerRejectionFeedback[],
  budget: MergeGateBudget,
): Promise<"rework" | "halt"> {
  if (decision.kind === "halt") {
    // A FIXED POINT (the same gate error recurs with no shrinking error count) — a TRANSIENT
    // failure (the writer's own scaffold/tests), so the spec RE-DRIVES (not parks).
    await finalizeNonPassOutcome(input, finalizeRunState, context, appendEvent, "merge_gate_unsatisfied");
    return "halt";
  }
  // Record this gate-failure attempt (signature + magnitude) so the next iteration's detector
  // sees the trajectory (a CHANGED error OR a SHRINKING error count ⇒ keep re-working; the SAME
  // error recurring with no magnitude decrease ⇒ a fixed point ⇒ halt).
  budget.used += 1;
  budget.attempts.push(decision.attempt);
  seedRejections.push(decision.rejection);
  await setSpecStatus(input, context, "in_flight");
  return "rework";
}

/**
 * Apply a PR review verdict to the planner loop (apex v35 — no count budget): `approved` →
 * `merge`; `changes_requested` whose feedback is DIFFERENT — OR whose requested-change count
 * SHRANK (the writer is closing the reviewer's asks one after another, the same kind of
 * trajectory the merge gate has) — → re-enter the writer (`rework`), UNBOUNDED while it makes
 * progress; changes-requested at a GENUINE FIXED POINT (the SAME feedback recurs with no
 * shrinking magnitude) → `halt`. The review stage awaits its verdict INDEFINITELY (no poll
 * budget, feedback_no_timeouts_progress_based), so `pending` never reaches here. Mutates
 * `reviewAttempts` on a `rework`.
 */
export async function applyReviewVerdict(
  input: RunPlannerLoopInput,
  finalizeRunState: FinalizeRunState,
  context: PlannerRunContext,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  review: { verdict: string; rejection: PlannerRejectionFeedback },
  seedRejections: PlannerRejectionFeedback[],
  reviewAttempts: GateAttempt[],
): Promise<"merge" | "rework" | "halt"> {
  if (review.verdict === "approved") {
    return "merge";
  }
  if (review.verdict === "changes_requested") {
    const reason = review.rejection.rejectionReason;
    const magnitude = outputMagnitude(reason);
    const attempt: GateAttempt = {
      signature: gateErrorSignature(reason),
      ...(magnitude !== undefined && { magnitude }),
    };
    // PROGRESS while the feedback keeps changing OR its requested-change count keeps shrinking
    // (re-work UNBOUNDED); a GENUINE FIXED POINT (the SAME feedback recurs with no magnitude
    // decrease) → halt. The magnitude-aware detector decides — no count.
    if (!(await atGateFixedPoint(reviewAttempts, attempt))) {
      reviewAttempts.push(attempt);
      seedRejections.push(review.rejection);
      await setSpecStatus(input, context, "in_flight");
      return "rework";
    }
  }
  // Changes-requested at a review-feedback FIXED POINT (the SAME feedback recurs) — a
  // TRANSIENT stall, so the spec RE-DRIVES (the walker re-attempts), not parks.
  await finalizeNonPassOutcome(input, finalizeRunState, context, appendEvent, "review_stalled");
  return "halt";
}
