// P3-0001: public worker surface + the env-gated in-process lifecycle helper
// the orchestrator server-start path calls.

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import { PgJobQueue } from "../contracts/jobQueue.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { JobReaper } from "./jobReaper.js";
import { RunWorker, type RunWorkerOptions } from "./runWorker.js";

export {
  executeNextPlanJob,
  DEFAULT_ESCAPE_HATCHES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CI_POLLS,
  DEFAULT_CI_POLL_DELAY_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  type RunExecutorDeps,
  type ExecuteJobResult
} from "./runExecutor.js";
export { RunWorker, type RunWorkerOptions } from "./runWorker.js";
export {
  reapExpiredJobs,
  JobReaper,
  type ReapJobsDeps,
  type ReapJobsResult,
  type JobReaperOptions
} from "./jobReaper.js";
export {
  loadRunExecutionContext,
  RunExecutionContextNotFoundError,
  type RunExecutionContext
} from "./runExecutionContext.js";

/** True when the in-process run worker is enabled (TANREN_RUN_WORKER=1). */
export function runWorkerEnabled(): boolean {
  return process.env.TANREN_RUN_WORKER === "1";
}

function workerConcurrencyFromEnv(): number {
  const raw = process.env.TANREN_RUN_WORKER_CONCURRENCY;
  if (raw === undefined || raw === "") {
    return 2;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
}

export interface StartRunWorkerInput {
  pool: pg.Pool;
  allocator: Allocator;
  ssh: SshSubstrate;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  identitySecretRef: string;
  options?: RunWorkerOptions;
}

/**
 * Build + start a {@link RunWorker} bound to a real {@link PgJobQueue} and
 * install SIGTERM/SIGINT graceful-drain handlers. Returns the worker so the
 * caller can `await worker.stop()` in its own shutdown path if it owns one.
 *
 * Flag-gating is the CALLER's responsibility (`runWorkerEnabled()`); this
 * function always starts so it stays trivially testable.
 */
export function startRunWorker(input: StartRunWorkerInput): RunWorker {
  const jobQueue = new PgJobQueue(input.pool);
  const worker = new RunWorker(
    {
      pool: input.pool,
      jobQueue,
      allocator: input.allocator,
      ssh: input.ssh,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      identitySecretRef: input.identitySecretRef
    },
    { concurrency: workerConcurrencyFromEnv(), ...input.options }
  );
  worker.start();
  // P3-0028: a co-located reaper recovers leases dropped by crashed workers.
  const reaper = new JobReaper({ pool: input.pool, jobQueue });
  reaper.start();
  installSignalHandlers(worker, reaper);
  return worker;
}

let signalHandlersInstalled = false;

/** Wire SIGTERM/SIGINT to drain the worker + reaper, then exit. Installed once. */
function installSignalHandlers(worker: RunWorker, reaper: JobReaper): void {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  const drain = (signal: NodeJS.Signals) => {
    console.log(`[run-worker] ${signal} received — draining in-flight jobs`);
    Promise.all([worker.stop(), reaper.stop()])
      .catch((error) => console.error(`[run-worker] drain error: ${String(error)}`))
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => drain("SIGTERM"));
  process.once("SIGINT", () => drain("SIGINT"));
}
