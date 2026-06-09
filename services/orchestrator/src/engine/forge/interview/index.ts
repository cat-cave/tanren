// greenfield onboarding: vision-interview engine barrel.
//
// The multi-round Forge vision interview (round → accumulate capture) and the
// completion derivation (capture → project + personas/behaviors/milestones/
// specs via the entity-creation paths). The interview route imports `runRound` +
// `deriveFromCapture` and wires the provider answerer; tests inject a fixture.

export {
  runRound,
  deriveFromCapture,
  emptyCapture,
  DEFAULT_TOTAL_ROUNDS,
  type InterviewEngineDeps,
  type RunRoundInput,
  type RunRoundResult,
  type DeriveFromCaptureInput,
  type DeriveResult,
} from "./engine.js";
export {
  DeployNotLinkedError,
  DeployProviderInvalidError,
  DeployProviderMissingError,
  DeployProvisioningUnavailableError,
  isDeployNotLinked,
  missingDeployProviderError,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type DeployPreflightCallback,
  type GreenfieldDeployDependency,
  type PrepareDeployCallback,
  type PreparedGreenfieldDeploy,
} from "./deployDependency.js";

export { wrapProviderInterviewAnswerer, type WrapProviderInterviewAnswererOptions } from "./providerAnswerer.js";
export { buildInterviewPrompt } from "./prompt.js";
export { mergeCapture } from "./capture.js";
export {
  buildScaffoldDescription,
  buildScaffoldAcceptanceCriteria,
  buildSeedScaffoldDescription,
  buildSeedScaffoldAcceptanceCriteria,
  MissingLifecycleError,
} from "./scaffoldAuthoring.js";

// TEMPLATING WAVE 3 — the Forge SELECTION integration (templating-system.md §3): the
// capability-query derivation + scorer + the seed/from-scratch decision.
export {
  deriveCapabilityQuery,
  isProofFresh,
  isTemplateEligible,
  rankTemplates,
  scoreTemplate,
  selectTemplate,
  PROOF_FRESHNESS_MS,
  SEEDABLE_STATUSES,
  type ChannelPreference,
  type ScoredTemplate,
  type SelectedTemplate,
  type SelectionKind,
  type TemplateRegistryQuery,
  type TemplateSelectionDecision,
} from "./templateSelection.js";

export {
  InterviewCapture,
  InterviewRoundOutput,
  InterviewSuggestion,
  CaptureIdentity,
  CapturePersona,
  CaptureBehavior,
  CaptureInterface,
  CaptureArchitectureLine,
  CaptureLifecycle,
  type InterviewAnswerer,
  type InterviewAnswererContext,
} from "./types.js";
