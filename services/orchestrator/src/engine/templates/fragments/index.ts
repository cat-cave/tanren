// Single import surface for the template-fragment composition path
// (docs/roadmap/templating-system.md).

export { composeTemplate, deployFragmentId, runtimeFragmentId, compose, type PhaseFragmentRef } from "./compose.js";
export {
  type DependencyRuntimeMismatchPayload,
  TemplateComposeError,
  type TemplateComposePhase,
} from "./composeError.js";
export {
  AddonId,
  AuthId,
  BackendId,
  DbId,
  DeployId,
  type EnvReconciliation,
  ExampleId,
  type Fragment,
  type FragmentContract,
  type FragmentId,
  FragmentKind,
  FragmentLibrary,
  FrontendId,
  RuntimeId,
  TemplateConfig,
  VfsCollisionError,
  VirtualFileSystem,
} from "./types.js";
export {
  ADDON_BIOME_ID,
  ADDON_DOCKER_ID,
  BASE_FRAGMENT_ID,
  BASE_FRAGMENT_VERSION,
  BASE_JUSTFILE_TARGETS,
  BASE_PROTECTED_FILES,
  DB_POSTGRES_PRISMA_ID,
  DEPLOY_FLY_ID,
  DEPLOY_NONE_ID,
  FRONTEND_REACT_ROUTER_ID,
  FRONTEND_REMIX_ID,
  loadFragmentLibrary,
  loadFragmentLibraryForTests,
  RUNTIME_NODE_PNPM_ID,
  RUNTIME_RUBY_BUNDLER_ID,
} from "./library/index.js";
export {
  canonicalizeStack,
  CURATED_TEMPLATES,
  type CuratedTemplate,
  listCurated,
  lookupCurated,
} from "./registry/index.js";
export {
  buildMaterializeTemplate,
  type MaterializeDeps,
  type MaterializeInput,
  type MaterializeTemplate,
  type SeededTemplate,
} from "./materialize.js";
export {
  deriveTemplateConfigFromLifecycle,
  type DeriveTemplateConfigResult,
  FragmentAuthoringFailedError,
  type FragmentSpec,
  selectFragmentConfig,
  type SelectFragmentConfigResult,
  UnresolvableLifecycleError,
} from "./selectFragmentConfig.js";
export { deriveImplicitDependsOn } from "./implicitDependsOn.js";
export {
  buildFragmentAuthoring,
  FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX,
  type FragmentAuthoring,
  type FragmentAuthoringAttemptDecision,
  type FragmentAuthoringDeps,
  type FragmentAuthoringEvents,
  type FragmentAuthoringInput,
  type FragmentAuthoringResult,
  type FragmentAuthorer,
  type FragmentAuthorerInput,
  type FragmentAuthorerOutput,
  type FragmentPersistence,
  truncateBodyPreview,
} from "./fragmentAuthoringRun.js";
export { type PriorFragment, type ProductContext } from "./fragmentAuthoringContextTypes.js";
export {
  EXEMPLAR_MAX_CHARS,
  exemplarFor,
  FRAGMENT_EXEMPLARS,
  type FragmentExemplar,
  truncateExemplar,
} from "./fragmentAuthorerExemplars.js";
export {
  deriveRuntimeLanguage,
  SUPPORTED_RUNTIME_LANGUAGES,
  type SupportedRuntimeLanguage,
  unsupportedRuntimeLanguageReason,
} from "./runtimeLanguage.js";
export { canonicalizeBodySignature, lexicallyNormalize } from "./canonicalizeBody.js";
export {
  configForFullLibrarySmoke,
  configForSmoke,
  runFullLibrarySmokeComposition,
  runSmokeComposition,
  type SmokeFailed,
  type SmokeOk,
  type SmokeResult,
} from "./smokeComposition.js";
export {
  type BundleInvoker,
  type BundleInvokerInput,
  type BundleInvokerResult,
  parsePnpmError,
  type PnpmInvoker,
  type PnpmInvokerInput,
  type PnpmInvokerResult,
  runRuntimeValiditySmoke,
  type RuntimeValiditySmokeDeps,
} from "./runtimeValiditySmoke.js";
export { buildLiveBundleInvoker, buildLivePnpmInvoker } from "./runtimeValiditySmokeLive.js";
export {
  BASE_SKELETON_TEST_PATHS,
  hasMeaningfulAssertion,
  isCandidateTestPath,
  SCENARIO_HEADER,
} from "./functionalTestRecognizer.js";
export {
  buildFragmentAuthorerPrompt,
  FRAGMENT_AUTHORER_PROMPT_MAX_CHARS,
  wrapProviderFragmentAuthorer,
} from "./providerFragmentAuthorer.js";
export {
  assertComposedCiYmlParsesAsCiConfigV1,
  assertPnpmInstallIsNonInteractive,
  assertScaffoldBootstrapsFromFreshCheckout,
} from "./runtimeValidation.js";
export {
  FragmentBodyParseError,
  type FragmentOp,
  interpretOrgFragment,
  loadUnifiedFragmentLibrary,
  type LoadOrgFragments,
  type OrgFragmentSource,
  parseFragmentBody,
} from "./unifiedLibrary.js";
