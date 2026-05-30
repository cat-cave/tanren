// P3-0001: public worker surface. The env-gated in-process lifecycle helpers
// (`startRunWorker` / `runWorkerEnabled`) live in `lifecycle.ts`; the standalone
// boot (`bootRunWorker`) lives in `boot.ts`. This barrel re-exports both so the
// public surface is one import site — and so `boot.ts` can import the lifecycle
// helpers from `lifecycle.ts` directly (no barrel↔boot import cycle).

export {
  executeNextPlanJob,
  DEFAULT_ESCAPE_HATCHES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CI_POLLS,
  DEFAULT_CI_POLL_DELAY_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  type RunExecutorDeps,
  type ExecuteJobResult,
} from "./runExecutor.js";
export { RunWorker, type RunWorkerOptions } from "./runWorker.js";
// P3-0001 / plane-split P1: the in-process lifecycle helpers (split out to break
// the barrel↔boot cycle) + the shared standalone boot the `worker-main.ts`
// entrypoint and the in-process flag path (main.ts) both call.
export { runWorkerEnabled, startRunWorker, type StartRunWorkerInput, type StartedRunWorker } from "./lifecycle.js";
export { bootRunWorker, type BootedRunWorker } from "./boot.js";
// Plane-split P3: the run-state WRITER impls + env resolver (the DEFAULT direct
// in-process writer vs the remote control-plane writer over mTLS).
export { DirectRunStateWriter } from "./directRunStateWriter.js";
export { HttpRunStateWriter, RunStateWriteTransportError } from "./httpRunStateWriter.js";
export { buildRunStateWriterFromEnv, remoteWritesEnabled } from "./runStateWriterFromEnv.js";
export {
  reapExpiredJobs,
  JobReaper,
  type ReapJobsDeps,
  type ReapJobsResult,
  type JobReaperOptions,
} from "./jobReaper.js";
export {
  loadRunExecutionContext,
  RunExecutionContextNotFoundError,
  type RunExecutionContext,
} from "./runExecutionContext.js";
// SaaS Tier-B quota-admission-gate (OSS↔hosting seam): re-export the policy
// surface + metering reads so the worker barrel is the single import site for
// wiring a hosting policy.
export {
  type QuotaPolicy,
  type AdmissionRequest,
  type AdmissionDecision,
  type RunUsage,
  type UsageWindow,
  type OrgUsage,
  type BillableRun,
  NoopQuotaPolicy,
  DbQuotaPolicy,
  getOrgUsage,
  streamBillableRuns,
  getRunUsage,
} from "../quota/index.js";
