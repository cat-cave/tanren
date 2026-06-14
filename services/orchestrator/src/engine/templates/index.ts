// Single import surface for Tanren-native templating. Two surfaces meet here:
//
//   WAVE 1 — the template OBJECT: the `.tanren/template.yml` manifest schema + its
//   fail-loud parser (manifest.ts). The registry STORE rides the `Repositories` seam
//   (engine/repositories/templates.ts); the operator routes live under
//   routes/templates. The manifest carries the CANONICAL validation-proof shape
//   (`TemplateValidationProof` + `NegativeControlResult`).
//
//   WAVE 2 — the VALIDATION HARNESS (validationHarness.ts / negativeControls.ts /
//   scratchCopy.ts / validationProof.ts): it PROVES a template's gates actually CHECK
//   — the "meaningful, not green-by-accident" oracle (templating-system.md §2.4). The
//   harness produces a `TemplateValidationProof` (wave 1's shape — unified, no
//   duplicate type), so its output populates `TemplateManifestV1.validationProof`
//   directly; `templateValidates(proof)` is the published-or-not verdict.
export {
  NegativeControlResult,
  TemplateCapabilities,
  TemplateChannel,
  TemplateManifestV1,
  TemplateManifestValidationError,
  TemplateManifestYamlParseError,
  TemplateProvenance,
  TemplateValidationProof,
  manifestToJson,
  parseTemplateManifest,
} from "./manifest.js";
export { runValidationHarness, type TemplateAuditor, type ValidationHarnessInput } from "./validationHarness.js";
export { NEGATIVE_CONTROL_CAPABILITIES, templateValidates } from "./validationProof.js";
export {
  buildNegativeControlPlan,
  failingTestDefect,
  lintViolationDefect,
  mutationSeedDefect,
  type GateInvocation,
  type InjectedDefectFile,
  type NegativeControl,
  type NegativeControlCapability,
  type NegativeControlPlanInput,
  type PlantedDefect,
  typeErrorDefect,
  DEFAULT_TS_COVERED_SOURCE_PATH,
  DEFAULT_TS_TEST_PATH,
  DEFAULT_TS_MUTATION_SEED_PATH,
} from "./negativeControls.js";
export { ScratchCopyError } from "./scratchCopy.js";
// WAVE 4 — the CREATION META-DAG: `createTemplate(request)` runs research → author
// → build → validate → publish, REUSING the loop (deriveProductGraph + the
// DagWalker, via the build-driver seam) + the wave-2 harness + the wave-1 registry,
// and publishes ONLY a template whose `templateValidates(proof)` is true (the
// fail-closed gate). Plus the no-match auto-trigger hook selection calls.
export {
  type BuiltTemplate,
  type CreateTemplateDeps,
  type CreateTemplateResult,
  type NoMatchDecision,
  type ResearchedLifecycle,
  type ResearchedTooling,
  type TemplateBuildDriver,
  TemplateBuildFailedError,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
  TemplateValidationFailedError,
  UngroundedResearchError,
  assertGroundedResearch,
  authorTemplateBuildCapture,
  capabilitiesFor,
  createTemplate,
  maybeCreateTemplateForNoMatch,
  // Wave-4 LIVE seam impls (research + build-driver) — the real, mountable capability.
  buildTemplateResearcher,
  wrapProviderResearcher,
  buildRunLoopBuildDriver,
  resolveConvergedProjectFacts,
  buildTemplateAuditor,
  type ConvergedProjectFacts,
  type RunLoopBuildDriverDeps,
  // Template-build SELF-RECOVERY (templating-system.md §2): the bounded auto-requeue
  // of a stranded, bound template-build so it never needs manual DB clearing.
  recoverStrandedTemplateBuild,
  TemplateBuildRecoveryExhaustedError,
  DEFAULT_MAX_RECOVERY_ATTEMPTS,
  consecutiveNoProgressCount,
  buildLiveTemplateBuildRecovery,
  type TemplateBuildRecoveryDeps,
  type TemplateBuildRecoveryOutcome,
  type RecoveryProgressSignal,
  // CREATION-TIME UPGRADE (environment-management.md §4.5/§7 P1): the once-at-birth,
  // gated `just upgrade` node so a freshly-created template starts near-latest.
  buildCreationUpgrade,
  runCreationTimeUpgrade,
  type CreationUpgrade,
  type CreationUpgradeDeps,
  type CreationUpgradeInput,
  type CreationUpgradeOutcome,
} from "./creation/index.js";
// WAVE 5 — the MAINTENANCE flow (templating-system.md §4): the re-validation loop,
// the lts/nightly channel policy, the nightly→lts graduation gate (the canary), and
// the freshness/degraded-marking. Re-exported from the maintenance barrel.
export {
  CHANNEL_CADENCE_MS,
  channelAcceptsVersion,
  channelCadence,
  DEFAULT_FRESHNESS_HORIZON_MS,
  DEFAULT_GRADUATION_AGING_MS,
  eligibleToGraduate,
  graduationDecision,
  isPrerelease,
  isTemplateMaintenanceDue,
  proofExpired,
  regressionFinding,
  runMaintenancePass,
  shouldDegrade,
  TemplateMaintenanceLoop,
  type GraduationDecision,
  type GraduationIneligibility,
  type MaintainableTemplate,
  type MaintenancePassOutcome,
  type TemplateMaintenanceLoopDeps,
  type TemplateMaintenanceResult,
  type TemplateRevalidator,
} from "./maintenance/index.js";
