// P3-0001 / plane-split P1: the run-worker lifecycle helpers — `startRunWorker`
// (build + start the worker and its co-located reaper, install graceful-drain
// signal handlers) and the `runWorkerEnabled()` flag gate.
//
// Split out of the worker barrel (`index.ts`) so `boot.ts` can import
// `startRunWorker` WITHOUT importing the barrel that re-exports `boot.ts` — that
// barrel↔boot import cycle is what this module breaks. The barrel re-exports
// everything here so the public surface is unchanged.

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { JobClaimClient } from "../contracts/jobClaim.js";
import { PgJobQueue } from "../contracts/jobQueue.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { QuotaPolicy } from "../quota/index.js";
import { JobReaper } from "./jobReaper.js";
import { RunWorker, type RunWorkerOptions } from "./runWorker.js";

/** True when the in-process run worker is enabled (TANREN_RUN_WORKER=1). */
export function runWorkerEnabled(): boolean {
  return process.env["TANREN_RUN_WORKER"] === "1";
}

function workerConcurrencyFromEnv(): number {
  const raw = process.env["TANREN_RUN_WORKER_CONCURRENCY"];
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
  // SaaS Tier-B quota-admission-gate (OSS↔hosting seam). Omit for the unlimited
  // default (self-host is unrestricted); a hosting layer passes its own policy.
  quotaPolicy?: QuotaPolicy;
  // Plane-split P2: how the worker CLAIMS. Omit for the direct DB-CAS over a
  // `PgJobQueue` (the in-process / single-process path); the cross-process
  // `worker` container passes an `HttpJobClaimClient` that claims over the mTLS
  // control-plane endpoint.
  claimClient?: JobClaimClient;
  // Plane-split P3: how the worker WRITES the run's tenant state. Omit (the
  // DEFAULT) for today's in-process org-scoped DB writes; the cross-process
  // `worker` container passes an `HttpRunStateWriter` (under
  // TANREN_DATA_PLANE_REMOTE_WRITES=1) that routes writes through the
  // control-plane endpoints over mTLS.
  runStateWriter?: RunStateWriter;
  options?: RunWorkerOptions;
}

/** The started worker + its co-located reaper, so a caller can drain both. */
export interface StartedRunWorker {
  worker: RunWorker;
  reaper: JobReaper;
}

/**
 * Build + start a {@link RunWorker} (and its co-located {@link JobReaper}) bound
 * to a real {@link PgJobQueue} and install SIGTERM/SIGINT graceful-drain
 * handlers. Returns BOTH so a caller that owns the process lifecycle (the
 * standalone `worker-main.ts` entrypoint, tests) can `await worker.stop()` +
 * `await reaper.stop()` to drain deterministically.
 *
 * Flag-gating is the CALLER's responsibility (`runWorkerEnabled()`); this
 * function always starts so it stays trivially testable.
 */
export function startRunWorker(input: StartRunWorkerInput): StartedRunWorker {
  const jobQueue = new PgJobQueue(input.pool);
  const worker = new RunWorker(
    {
      pool: input.pool,
      jobQueue,
      allocator: input.allocator,
      ssh: input.ssh,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      identitySecretRef: input.identitySecretRef,
      ...(input.quotaPolicy === undefined ? {} : { quotaPolicy: input.quotaPolicy }),
      ...(input.claimClient === undefined ? {} : { claimClient: input.claimClient }),
      ...(input.runStateWriter === undefined ? {} : { runStateWriter: input.runStateWriter }),
    },
    { concurrency: workerConcurrencyFromEnv(), ...input.options },
  );
  worker.start();
  // P3-0028: a co-located reaper recovers leases dropped by crashed workers.
  const reaper = new JobReaper({ pool: input.pool, jobQueue });
  reaper.start();
  installSignalHandlers(worker, reaper);
  return { worker, reaper };
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
