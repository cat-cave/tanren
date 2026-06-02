// Single import surface for versioned org + project config.
export {
  AllocatorConfig,
  AllocatorKind,
  DEFAULT_SPECULATION_THRESHOLD,
  DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
  EscapeHatches,
  ForgePersona,
  GovernancePosture,
  HealthHint,
  MergeIntegration,
  NotificationTargetRef,
  PartialAllocatorConfig,
  PartialEscapeHatches,
  PartialForgePersona,
  ReviewPolicy,
  RoleId,
  RoutingChain,
  RoutingChainEntry,
  RoutingTable,
  SpeculationThreshold,
  UnknownConfigVersionError,
  emptyRoutingTable,
  resolveWorkerConcurrency,
} from "./shared.js";

export {
  DEFAULT_MANAGED_CREDENTIAL_REF,
  DEFAULT_MANAGED_ENDPOINT,
  ManagedProviderConfig,
  ProviderMode,
  defaultManagedProviderConfig,
  resolveHarnessEndpointOverride,
} from "./managedProvider.js";
export type { HarnessEndpointOverride } from "./managedProvider.js";

export {
  OrgAuditGateTarget,
  OrgConfigV1,
  OrgConfigVersioned,
  OrgDefaultCredentials,
  OrgGithubAppInstallation,
  SUPPORTED_ORG_CONFIG_VERSIONS,
  defaultOrgConfigV1,
  migrateOrgConfig,
  orgConfigJsonSchema,
} from "./orgConfig.js";

export {
  applyOnMerge,
  buildConfigPrTitle,
  gatedConfigWrite,
  isBucketBChange,
  renderTanrenYaml,
  renderTanrenYamlDiff,
} from "./tanrenConfigGate.js";
export type {
  ConfigYamlDiffLine,
  GatedConfigWriteInput,
  GatedConfigWriteResult,
  GateConfigPullRequest,
} from "./tanrenConfigGate.js";

export {
  ProjectConfigV1,
  ProjectConfigVersioned,
  ProjectCredentialRefs,
  SUPPORTED_PROJECT_CONFIG_VERSIONS,
  defaultProjectConfigV1,
  migrateProjectConfig,
  projectConfigJsonSchema,
} from "./projectConfig.js";
