// P3-0021 scheduled-audits barrel. The audits route + tests import the typed
// surface from here.

export {
  AuditKind,
  AuditCadence,
  AuditFindingSeverity,
  AuditFindingsSummary,
  AuditJob,
  type AuditFinding,
  type AuditPassResult,
  type AuditPassRunner,
} from "./types.js";

export {
  createAuditJob,
  listAuditJobs,
  getAuditJob,
  setAuditJobEnabled,
  recordAuditRun,
  type CreateAuditJobInput,
} from "./store.js";

export { runAuditJob, summarizeFindings, type AuditSchedulerDeps, type RunAuditJobResult } from "./scheduler.js";

export { recommendCoverage, type AuditRecommendation } from "./recommended.js";

export { createNoopPassRunner } from "./defaultPassRunner.js";
