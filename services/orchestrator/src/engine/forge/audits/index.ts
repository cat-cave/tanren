// P3-0021 scheduled-audits barrel. The audits route + tests import the typed
// surface from here.

export {
  AuditKind,
  AuditCadence,
  AuditFindingSeverity,
  AuditFindingsSummary,
  AuditJob,
  AuditPassReport,
  AuditReportFinding,
  type AuditFinding,
  type AuditPassResult,
  type AuditPassRunner,
  type AuditAnswerer,
  type AuditAnswererContext,
} from "./types.js";

export { AuditsStore, type CreateAuditJobInput } from "./store.js";

export {
  runAuditJob,
  summarizeFindings,
  AuditTriageAnswererUnconfiguredError,
  type AuditSchedulerDeps,
  type RunAuditJobResult,
} from "./scheduler.js";

export { recommendCoverage, type AuditRecommendation } from "./recommended.js";

export { wrapProviderAuditAnswerer, type WrapProviderAuditAnswererOptions } from "./auditAnswerer.js";
export { buildAuditPrompt } from "./prompt.js";
export {
  createAnswererPassRunner,
  AuditJobNotProjectScopedError,
  AuditProjectRepoUnresolvableError,
  type AnswererPassRunnerDeps,
} from "./answererPassRunner.js";

export { AuditSchedulerLoop, isAuditJobDue, type AuditSchedulerLoopDeps } from "./loop.js";
