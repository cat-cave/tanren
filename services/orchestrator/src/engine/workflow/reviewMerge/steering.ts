// turn a changes-requested PR review OR a failed pre_merge gate into the
// planner-feedback record routed through the same rework path the checker/auditor/gate
// use. Kept out of plannerRun.ts so that file stays under the 500-line architecture cap.

import type { GateOutcome } from "../gate/index.js";
import type { PlannerRejectionFeedback } from "../planner/planner.js";
import { gateReason } from "../subtaskInnerLoop.js";
import type { PollReviewForRunResult } from "./reviewPolling.js";

/**
 * The reviewer's body (when present) becomes the planner steering;
 * behaviorIdsFailed is empty because a review is prose, not a per-behavior
 * verdict, and previousSubtasks is empty (the planner re-decomposes the spec).
 */
export function reviewerRejection(review: PollReviewForRunResult, branch: string): PlannerRejectionFeedback {
  const reviewer = review.reviewer === undefined ? "a reviewer" : `@${review.reviewer}`;
  const feedback = review.feedback === undefined || review.feedback === "" ? "(no written feedback)" : review.feedback;
  return {
    producer: "reviewer",
    rejectionReason: `PR #${review.prNumber} (${branch}) had changes requested by ${reviewer}: ${feedback}`,
    behaviorIdsFailed: [],
    previousSubtasks: [],
  };
}

/**
 * SELF-HEAL (apex v34): turn a failed `pre_merge` ("merge"-tier) gate into the
 * planner-feedback record that re-enters the writer loop — mirroring `reviewerRejection`
 * (the review-rework re-entry) but for the merge-authority gate. The merge tier is the
 * writer's OWN scaffold/tests (e.g. a `tier-3` of cucumber+stryker that exits 1), so a
 * failure is WRITER-FIXABLE: the writer re-authors against the concrete failure instead
 * of the run stranding `code:internal`. The steering carries the FAILING tier/step PLUS
 * the failed step's captured output tail (via the SAME `gateReason` the fast-tier gate
 * feeds the writer) so the writer fixes the actual cucumber/stryker error — not a vague
 * "tier-3 failed". `producer: "gate"` routes it through the existing gate-rework path;
 * `behaviorIdsFailed`/`previousSubtasks` are empty (the planner re-decomposes the spec).
 */
export function mergeGateRejection(gate: Extract<GateOutcome, { passed: false }>): PlannerRejectionFeedback {
  return {
    producer: "gate",
    rejectionReason:
      `The pre-merge gate (the merge authority) failed, so the PR cannot merge (fail-closed — ` +
      `the merge tier is NOT a pass). This is the merge-tier gate over your OWN scaffold/tests; ` +
      `fix it so the merge gate passes. ${gateReason(gate)}`,
    behaviorIdsFailed: [],
    previousSubtasks: [],
  };
}
