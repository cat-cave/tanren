// Template-MAINTENANCE barrel (docs/roadmap/templating-system.md §4) — the wave
// that makes templates first-class Tanren projects Tanren maintains: the
// re-validation loop, the channel update policy (lts vs nightly), the nightly→lts
// graduation gate (the canary), and the degraded-marking (freshness). It REUSES the
// scheduled-audit + DAG-re-entry machinery; the maintenance-specific pieces live here.

export { CHANNEL_CADENCE_MS, channelAcceptsVersion, channelCadence, isPrerelease } from "./channelPolicy.js";
export { DEFAULT_FRESHNESS_HORIZON_MS, proofExpired, shouldDegrade } from "./freshness.js";
export {
  DEFAULT_GRADUATION_AGING_MS,
  eligibleToGraduate,
  graduationDecision,
  type GraduationDecision,
  type GraduationIneligibility,
} from "./graduation.js";
export {
  regressionFinding,
  runMaintenancePass,
  type MaintainableTemplate,
  type MaintenancePassOutcome,
  type TemplateRevalidator,
} from "./maintenancePass.js";
export {
  isTemplateMaintenanceDue,
  TemplateMaintenanceLoop,
  type TemplateMaintenanceLoopDeps,
  type TemplateMaintenanceResult,
} from "./loop.js";
export { harnessRevalidator, type ProvisionedTemplate, type TemplateWorkspaceProvisioner } from "./revalidator.js";
export { startTemplateMaintenance, type BootedTemplateMaintenance, type BootTemplateMaintenanceDeps } from "./boot.js";
