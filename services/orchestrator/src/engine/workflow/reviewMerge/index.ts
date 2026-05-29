// P3-0008: the review→merge completion half of the run loop. Barrel export so
// plannerRun.ts (and tests) import the stages + their types from one place.

export {
  DEFAULT_TANREN_LOGIN,
  loadReviewMergeRunContext,
  ReviewMergeRunNotFoundError,
  ReviewMergePullRequestNotFoundError,
  type ReviewMergeRunContext,
  type RunStateClient
} from "./context.js";
export {
  assessExternalChange,
  decidePosture,
  tanrenIdentity,
  type ContributorProbe,
  type ExternalChangeAssessment,
  type PostureDecision,
  type PostureDecisionKind,
  type PullRequestContributors,
  type TanrenIdentity
} from "./governancePosture.js";
export {
  pollReviewForRun,
  type PollReviewForRunInput,
  type PollReviewForRunResult,
  type ReviewProbe
} from "./reviewPolling.js";
export {
  mergeForRun,
  dispatchedIntegrationFor,
  noopConflictResolver,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type DispatchedIntegration,
  type MergeProbe,
  type ConflictResolverHook,
  type ConflictContext
} from "./mergeDispatch.js";
export { reviewerRejection } from "./steering.js";
