// P3-0008: turn a changes-requested PR review into the planner-feedback record
// routed through the same rework path the checker/auditor/gate use. Kept out of
// plannerRun.ts so that file stays under the 500-line architecture cap.

import type { PlannerRejectionFeedback } from "../planner/planner.js";
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
    previousSubtasks: []
  };
}
