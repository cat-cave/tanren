// Single import surface for the template-fragment composition path
// (docs/roadmap/templating-system.md §FRAGMENTS / PR-A).

export { composeTemplate, deployFragmentId, runtimeFragmentId } from "./compose.js";
export { TemplateComposeError, type TemplateComposePhase } from "./composeError.js";
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
  buildMaterializeCuratedTemplate,
  type MaterializeCuratedDeps,
  type MaterializeCuratedInput,
  type MaterializeCuratedTemplate,
} from "./materialize.js";
