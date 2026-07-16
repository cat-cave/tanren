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
  type LifecycleDriftNotice,
  type DeriveFromCaptureInput,
  type DeriveResult,
} from "./engine.js";
export {
  DeployNotLinkedError,
  DeploySelectionRequiredError,
  DeployProviderInvalidError,
  DeployProviderMissingError,
  DeployProvisioningUnavailableError,
  isDeployUnavailable,
  missingDeployProviderError,
  missingDeployProvisionerError,
  resolveGreenfieldDeployDependency,
  type DeployPreflightCallback,
  type GreenfieldDeployDependency,
  type GreenfieldDeployUnavailable,
  type PrepareDeployCallback,
  type PersistDeploySelectionCallback,
  type PreparedGreenfieldDeploy,
} from "./deployDependency.js";
export { DeployIneligibleError } from "./deployIneligibleError.js";

// TRANSACTIONAL ROLLBACK (task #78) — the compensation primitives the derive uses
// to atomically delete every external resource it created when a later step fails.
export {
  DeriveRollbackError,
  newDeriveCompensation,
  type CompensationFailure,
  type CompensationKind,
  type DeleteRepositoryCallback,
  type DeriveCompensation,
  type DeriveCompensationStep,
  type DestroyDeployAppCallback,
} from "./deriveCompensation.js";

// Native design subsystem (WS-D1) — the LOUD guards for a required design contract +
// dangling moat refs (mirroring `MissingLifecycleError`).
export { DanglingDesignRefError, MissingDesignContractError } from "./deriveDesignContract.js";

// Environment management (env-management.md §2.2 halt-loud, H1 #4) — re-exported so
// the greenfield onboarding route dispatches the typed error to a 400 body without
// reaching into `engine/environments/creation`.
export { JitBuildRequiredError } from "../../environments/creation/index.js";

export { wrapProviderInterviewAnswerer, type WrapProviderInterviewAnswererOptions } from "./providerAnswerer.js";
// fix/f2-prompt-hardening: the semi-structured product-context builder the derive
// threads into the F2 writer prompt (acceptance criteria + personas + behaviors).
export { buildProductContextFromCapture } from "./derive.js";
export { buildInterviewPrompt } from "./prompt.js";
export { mergeCapture, resolveLifecycle, type LifecycleResolution } from "./capture.js";
export {
  buildSeedScaffoldDescription,
  buildSeedScaffoldAcceptanceCriteria,
  MissingLifecycleError,
} from "./scaffoldAuthoring.js";

// Doctrine-collapse re-exports (docs/roadmap/templating-system.md): the new
// fragment-based scaffold-selection + authoring surface.
export {
  FragmentAuthoringFailedError,
  selectFragmentConfig,
  UnresolvableLifecycleError,
  type FragmentSpec,
  type SelectFragmentConfigResult,
} from "../../templates/fragments/index.js";

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
  MissingProjectSlugError,
  normalizeSlug,
  safeProjectSlug,
  type InterviewAnswerer,
  type InterviewAnswererContext,
} from "./types.js";
