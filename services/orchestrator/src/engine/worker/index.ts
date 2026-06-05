// public worker surface. The env-gated in-process lifecycle helpers
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
// The in-process lifecycle helpers (split out to break
// the barrel↔boot cycle) + the shared standalone boot the `worker-main.ts`
// entrypoint and the in-process flag path (main.ts) both call.
export { runWorkerEnabled, startRunWorker, type StartRunWorkerInput, type StartedRunWorker } from "./lifecycle.js";
export { bootRunWorker, type BootedRunWorker } from "./boot.js";
// The run-state WRITER impls + env resolver (the DEFAULT direct
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
// Metering-export (OSS↔hosting billing READ substrate): re-export the typed
// usage reads off `cost_records` so the worker barrel is the single import site
// for a hosting layer's transparent usage-based billing (autonomy-engine.md
// §1.x — budget is the only run gate; there are no quotas).
export {
  type UsageWindow,
  type OrgUsage,
  type BillableRun,
  getOrgUsage,
  streamBillableRuns,
  getRunUsage,
} from "../metering/index.js";
