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
// The validation-proof FRESHNESS predicate (the 30-day re-check). Physically lives with
// the Forge SELECTION logic but is a predicate OVER a `TemplateValidationProof`, shared
// by selection AND the creation no-match seam — surfaced here so creation-path callers
// read it from the template barrel rather than reaching into forge/interview.
export { isProofFresh, isTemplateEligible } from "../forge/interview/templateSelection.js";
export {
  assertComposedTemplateEvidenceDeclared,
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
  // Transient-tolerant retry for the pre-build creation answerer calls (research →
  // author): a timeout / transient transport blip RETRIES (bounded + backoff)
  // instead of failing the whole derive; a persistent failure fails loud after the bound.
  withAnswererRetry,
  isTransientAnswererError,
  PersistentAnswererOutageError,
  transientSignature,
  type AnswererRetryOptions,
  buildRunLoopBuildDriver,
  resolveConvergedProjectFacts,
  buildTemplateAuditor,
  type ConvergedProjectFacts,
  type RunLoopBuildDriverDeps,
  // CHILD-RUN PROGRESS PROBE (task #21B): the sign-of-life circuit breaker over
  // the child template-build project's append-only event-stream identity. Extends
  // the timeout-eradication doctrine; identity-based, never elapsed-time-based.
  buildChildRunProgressSignal,
  CHILD_PROGRESS_PROBE_CADENCE_MS,
  ChildRunStalledError,
  NON_ADVANCE_PROBES_BEFORE_STALL,
  WORKER_PROGRESS_EVENT_PREFIXES,
  type ChildRunStallSignal,
  // Template-build SELF-RECOVERY (templating-system.md §2): the UNBOUNDED-while-converging
  // auto-requeue of a stranded, bound template-build so it never needs manual DB clearing.
  recoverStrandedTemplateBuild,
  TemplateBuildRecoveryExhaustedError,
  atRecoveryFixedPoint,
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
// PR-A FRAGMENT-COMPOSITION foundation (docs/roadmap/templating-system.md §FRAGMENTS):
// the matrix-hit alternative to the agent template-build path. AGENT FALLBACK
// UNCHANGED in PR-A — fragments are additive.
export {
  ADDON_BIOME_ID,
  ADDON_DOCKER_ID,
  AddonId,
  AuthId,
  BackendId,
  BASE_FRAGMENT_ID,
  BASE_FRAGMENT_VERSION,
  BASE_JUSTFILE_TARGETS,
  BASE_PROTECTED_FILES,
  composeTemplate,
  DB_POSTGRES_PRISMA_ID,
  DbId,
  DEPLOY_FLY_ID,
  DEPLOY_NONE_ID,
  deployFragmentId,
  DeployId,
  ExampleId,
  type Fragment,
  type FragmentContract,
  type FragmentId,
  FragmentKind,
  FragmentLibrary,
  FRONTEND_REACT_ROUTER_ID,
  FrontendId,
  loadFragmentLibrary,
  loadFragmentLibraryForTests,
  mapDesignContractToTemplateConfig,
  RUNTIME_NODE_PNPM_ID,
  RUNTIME_RUBY_BUNDLER_ID,
  runtimeFragmentId,
  RuntimeId,
  type SchemaMappingResult,
  TemplateComposeError,
  type TemplateComposePhase,
  TemplateConfig,
  VfsCollisionError,
  VirtualFileSystem,
} from "./fragments/index.js";
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
