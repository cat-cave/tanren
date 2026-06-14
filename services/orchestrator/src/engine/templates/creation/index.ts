// Tanren-native templating (wave 4) — the CREATION META-DAG import surface. The
// `createTemplate(request)` meta-flow + its five steps (research → author → build
// → validate → publish), the fail-closed publish gate, and the no-match
// auto-trigger hook selection calls when no validated template matches. Everything
// live is a SEAM (research + build), so the orchestration is exercised against
// stubs; the validation + registry + derive it reuses come from the other waves.
export {
  type ResearchedLifecycle,
  type ResearchedTooling,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
  UngroundedResearchError,
  assertGroundedResearch,
} from "./research.js";
export { authorTemplateBuildCapture, capabilitiesFor } from "./specAuthoring.js";
export { type BuiltTemplate, type TemplateBuildDriver, TemplateBuildFailedError } from "./buildDriver.js";
// Wave-4 LIVE seam impls (the real, mountable capability):
export {
  buildResearchPrompt,
  buildTemplateResearcher,
  wrapProviderResearcher,
  type WrapProviderResearcherOptions,
} from "./liveResearch.js";
export { ResearchOutput } from "./researchSchema.js";
export { buildRunLoopBuildDriver, type ConvergedProjectFacts, type RunLoopBuildDriverDeps } from "./liveBuildDriver.js";
export { resolveConvergedProjectFacts } from "./convergedFacts.js";
export { buildTemplateAuditor } from "./liveAuditor.js";
export {
  createTemplate,
  type CreateTemplateDeps,
  type CreateTemplateResult,
  TemplateValidationFailedError,
} from "./createTemplate.js";
export { maybeCreateTemplateForNoMatch, type NoMatchDecision } from "./noMatchHook.js";
// Template-build SELF-RECOVERY (templating-system.md §2): the bounded auto-requeue of a
// stranded, bound template-build so it never needs manual DB clearing.
export {
  recoverStrandedTemplateBuild,
  TemplateBuildRecoveryExhaustedError,
  DEFAULT_MAX_RECOVERY_ATTEMPTS,
  consecutiveNoProgressCount,
  type TemplateBuildRecoveryDeps,
  type TemplateBuildRecoveryOutcome,
  type RecoveryProgressSignal,
} from "./recovery.js";
export { buildLiveTemplateBuildRecovery } from "./liveRecovery.js";
