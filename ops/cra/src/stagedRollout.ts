import type { ReviewOnceResult } from "./reviewOnce.js";

export interface StagedCandidateResult {
  readonly review: ReviewOnceResult;
  readonly routed: readonly number[];
  readonly mergeAttempted: boolean;
  readonly merged: boolean;
}

interface AuditOnlyStage {
  readonly mode: "shadow";
  readonly auditToLocalDraft: () => Promise<ReviewOnceResult>;
}

interface ReviewStage {
  readonly mode: "review";
  readonly auditAndPostReview: () => Promise<ReviewOnceResult>;
  readonly routeIssues: (review: ReviewOnceResult) => Promise<readonly number[]>;
  readonly superviseAbandonment: (review: ReviewOnceResult) => Promise<void>;
}

interface MergeStage {
  readonly mode: "merge";
  readonly auditAndPostReview: () => Promise<ReviewOnceResult>;
  readonly mergeIfClear: (review: ReviewOnceResult) => Promise<boolean>;
  readonly superviseAbandonment: (review: ReviewOnceResult) => Promise<void>;
}

export type StagedCandidateInput = AuditOnlyStage | ReviewStage | MergeStage;

function isApproved(review: ReviewOnceResult): boolean {
  return (
    !review.blocked &&
    review.verdict === "APPROVE" &&
    (review.state.disposition === "approved" || review.state.disposition === "merged")
  );
}

// The discriminated dependency shape is the enforcement boundary: shadow has no
// write capability at all, and review has no merge callback to call accidentally.
export async function runStagedCandidate(input: StagedCandidateInput): Promise<StagedCandidateResult> {
  if (input.mode === "shadow") {
    const review = await input.auditToLocalDraft();
    return { review, routed: [], mergeAttempted: false, merged: false };
  }

  const review = await input.auditAndPostReview();
  if (review.blocked) return { review, routed: [], mergeAttempted: false, merged: false };
  if (!isApproved(review)) {
    await input.superviseAbandonment(review);
    return { review, routed: [], mergeAttempted: false, merged: false };
  }
  if (input.mode === "review") {
    const routed = await input.routeIssues(review);
    return { review, routed, mergeAttempted: false, merged: false };
  }
  const merged = await input.mergeIfClear(review);
  return { review, routed: [], mergeAttempted: true, merged };
}
