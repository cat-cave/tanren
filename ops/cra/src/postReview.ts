import { routeDeferredFindings, type FindingIssueContext, type FindingIssueGateway } from "./findingIssues.js";
import {
  authorizeAndSquashMerge,
  type MergeAuthorizationInput,
  type MergeAuthorityGateway,
  type MergeAuthorityResult,
  type MergeDecisionRecorder,
} from "./mergeAuthority.js";
import type { PrState } from "./stateSchemas.js";
import type { PrStateStore } from "./stateStore.js";
import type { NormalizedFinding } from "./triage.js";

export interface ApprovedPostReviewDeps {
  readonly mergeGateway: MergeAuthorityGateway;
  readonly issueGateway: FindingIssueGateway;
  readonly stateStore: PrStateStore;
  readonly recorder?: MergeDecisionRecorder;
}

export interface ApprovedPostReviewInput {
  readonly state: PrState;
  readonly authorization: MergeAuthorizationInput;
  readonly issueContext: FindingIssueContext;
  readonly findings: readonly NormalizedFinding[];
}

export interface ApprovedPostReviewResult {
  readonly merge: MergeAuthorityResult;
  readonly state: PrState;
}

async function routeAndPersist(
  deps: ApprovedPostReviewDeps,
  input: ApprovedPostReviewInput,
  mergedState: PrState,
): Promise<PrState> {
  const issues = await routeDeferredFindings(deps.issueGateway, input.issueContext, input.findings);
  const next: PrState = {
    ...mergedState,
    followUpIssues: [...new Set([...mergedState.followUpIssues, ...issues.map((issue) => issue.number)])].sort(
      (left, right) => left - right,
    ),
  };
  await deps.stateStore.write(next);
  return next;
}

// The merge disposition is persisted immediately after GitHub's post-merge read.
// Follow-up routing happens second. If it fails, the next poll enters the `merged`
// recovery branch and retries marker-deduplicated routing without attempting merge.
export async function runApprovedPostReview(
  deps: ApprovedPostReviewDeps,
  input: ApprovedPostReviewInput,
): Promise<ApprovedPostReviewResult> {
  if (input.state.disposition === "merged") {
    const state = await routeAndPersist(deps, input, input.state);
    return {
      merge: { merged: true, verified: true, mergeCommitSha: null, reasons: ["recovered post-merge routing"] },
      state,
    };
  }
  let finalState = input.state;
  const merge = await authorizeAndSquashMerge(
    {
      gateway: deps.mergeGateway,
      recorder: deps.recorder,
      afterVerifiedMerge: async () => {
        const mergedState: PrState = {
          ...input.state,
          disposition: "merged",
          awaitingAuthorSince: null,
          reminderDaysSent: [],
          abandonmentReason: null,
        };
        await deps.stateStore.write(mergedState);
        finalState = mergedState;
        finalState = await routeAndPersist(deps, input, mergedState);
      },
    },
    input.authorization,
  );
  return { merge, state: finalState };
}
