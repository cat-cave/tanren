// the review→merge completion half of the run loop. Barrel export so
// plannerRun.ts (and tests) import the stages + their types from one place.

export {
  DEFAULT_TANREN_LOGIN,
  loadReviewMergeRunContext,
  ReviewMergeRunNotFoundError,
  ReviewMergePullRequestNotFoundError,
  type ReviewMergeRunContext,
  type RunStateClient,
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
  type TanrenIdentity,
} from "./governancePosture.js";
export {
  pollReviewForRun,
  type PollReviewForRunInput,
  type PollReviewForRunResult,
  type ReviewProbe,
  type SimulatedReviewSpec,
} from "./reviewPolling.js";
export {
  buildSimulatedReviewerPrompt,
  reviewEventFor,
  runSimulatedReviewer,
  type SimulatedReviewContext,
  type SimulatedReviewInput,
  type SimulatedReviewResult,
} from "./simulatedReviewer.js";
export {
  assertStrictForgeReceipt,
  bodyContainsTanrenSimulatedMarker,
  publishSimulatedReviewConvergent,
  reconcileExistingSimulatedReviews,
  resolveDistinctSimulatedReviewerToken,
  SimulatedReviewPublicationError,
  strictReviewEventFor,
  tanrenSimulatedReviewMarker,
  type ForgeReviewPublication,
} from "./simulatedReviewPublication.js";
export {
  InMemorySimulatedReviewIntentRepository,
  PgSimulatedReviewIntentRepository,
  REVIEW_SIMULATED_INTENT_EVENT,
  parseSimulatedReviewIntent,
  simulatedReviewIntentKey,
  type SimulatedReviewIntent,
  type SimulatedReviewIntentRepository,
} from "./simulatedReviewIntent.js";
export {
  InMemorySimulatedReviewPublishFence,
  PgAdvisorySimulatedReviewPublishFence,
  SIMULATED_REVIEW_PUBLISH_FENCE_NAMESPACE,
  SimulatedReviewPublishFenceBusyError,
  simulatedReviewPublishFenceMaterial,
  type SimulatedReviewPublishFence,
  type SimulatedReviewPublishFenceKey,
} from "./simulatedReviewPublishFence.js";
export {
  mergeForRun,
  dispatchedIntegrationFor,
  type MergeAuthorityBundle,
  type MergeForRunInput,
  type MergeForRunResult,
  type MergeOutcomeKind,
  type DispatchedIntegration,
  type MergeProbe,
  type ConflictResolverHook,
  type ConflictContext,
  type NativeQueueEnqueuer,
  type NativeQueueOnClientEnqueuer,
  type ReGateCiHook,
} from "./mergeDispatch.js";
export { mergeGateRejection, reviewerRejection } from "./steering.js";
// The shared convergence-signature helpers (apex v35) — re-exported here so the planner-loop
// modules reach them through this one barrel (keeping their dependency counts under cap).
export {
  atGateFixedPoint,
  atReplanFixedPoint,
  type GateAttempt,
  gateErrorSignature,
  outputMagnitude,
} from "./conflictResolver/replanRouter.js";
