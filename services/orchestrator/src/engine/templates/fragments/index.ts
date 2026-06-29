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
  type DesignContract,
  mapDesignContractToTemplateConfig,
  type SchemaMappingResult,
} from "./agentSchemaMapper.js";
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
export {
  buildFragmentAuthoring,
  deriveImplicitDependsOn,
  type FragmentAuthoring,
  type FragmentAuthoringDeps,
  type FragmentAuthoringEvents,
  type FragmentAuthoringInput,
  type FragmentAuthoringResult,
  type FragmentAuthorer,
  type FragmentAuthorerInput,
  type FragmentAuthorerOutput,
  type FragmentPersistence,
} from "./fragmentAuthoringRun.js";
export { buildFragmentAuthorerPrompt, wrapProviderFragmentAuthorer } from "./providerFragmentAuthorer.js";
export {
  assertComposedCiYmlParsesAsCiConfigV1,
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
