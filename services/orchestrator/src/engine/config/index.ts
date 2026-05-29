// Single import surface for versioned org + project config.
export {
  AllocatorConfig,
  AllocatorKind,
  EscapeHatches,
  ForgePersona,
  GovernancePosture,
  HealthHint,
  MergeIntegration,
  NotificationTargetRef,
  PartialAllocatorConfig,
  PartialEscapeHatches,
  PartialForgePersona,
  RoleId,
  RoutingChain,
  RoutingChainEntry,
  RoutingTable,
  UnknownConfigVersionError,
  emptyRoutingTable,
} from "./shared.js";

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
