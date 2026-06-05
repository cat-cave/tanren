// P3-0001 / plane-split P1: the run-worker lifecycle helpers — `startRunWorker`
// (build + start the worker and its co-located reaper, install graceful-drain
// signal handlers) and the `runWorkerEnabled()` flag gate.
//
// Split out of the worker barrel (`index.ts`) so `boot.ts` can import
// `startRunWorker` WITHOUT importing the barrel that re-exports `boot.ts` — that
// barrel↔boot import cycle is what this module breaks. The barrel re-exports
// everything here so the public surface is unchanged.

import { PgNotifyListener } from "@tanren/db";
import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { JobClaimClient } from "../contracts/jobClaim.js";
import { PgJobQueue } from "../contracts/jobQueue.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { RunCredentialScoping } from "../workflow/plannerRunScopedCreds.js";
// Re-exported so `boot.ts` builds the dimension-D credential-scoping seam from a
// module it already depends on (keeping boot's import-dependency count under cap).
export { buildRunCredentialScoping } from "../workflow/plannerRunScopedCreds.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { JobReaper } from "./jobReaper.js";
import { RunWorker, type RunWorkerOptions } from "./runWorker.js";

/** True when the in-process run worker is enabled (TANREN_RUN_WORKER=1). */
export function runWorkerEnabled(): boolean {
  return process.env["TANREN_RUN_WORKER"] === "1";
}

export interface StartRunWorkerInput {
  pool: pg.Pool;
  allocator: Allocator;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  // Managed-hosting dimension D: the per-run credential-scoping seam (Vault backend
  // only). Threaded to the executor so the workflow de-privileges the run's
  // credential reads behind a per-run child token.
  credentialScoping?: RunCredentialScoping;
  vcsProvider: VcsProvider;
  // P2a (Part 2): shared App installation-token minter (cache lives here),
  // threaded to the workflow so the App-first clone reuses it. Optional — the
  // provider mints a per-call minter when absent.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  // Concurrency is a GOVERNED CONFIG KNOB, never an env var (autonomy-engine.md
  // §1.4): the max in-flight run slots this worker maintains. Sourced from the
  // config surface's `AllocatorConfig.concurrency` (boot resolves it), so a
  // spend-rate change is config, not a redeploy. The future DagWalker reads the
  // same per-project/org ceiling and throttles BELOW it on live signals.
  concurrency: number;
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
  // LISTEN/NOTIFY: a dedicated long-lived LISTEN connection (held off the
  // worker's runtime pool) so an idle slot wakes the instant a job is enqueued
  // instead of polling. The `tanren_job_queue` channel is a payload-free
  // cross-tenant pulse, so LISTENing on the app-role pool leaks nothing. A
  // caller-supplied `notifyListener` (tests) overrides this; otherwise we build
  // one from the pool.
  const notifyListener = input.options?.notifyListener ?? new PgNotifyListener(input.pool);
  const worker = new RunWorker(
    {
      pool: input.pool,
      jobQueue,
      allocator: input.allocator,
      ssh: input.ssh,
      secrets: input.secrets,
      ...(input.credentialScoping === undefined ? {} : { credentialScoping: input.credentialScoping }),
      vcsProvider: input.vcsProvider,
      ...(input.githubAppMinter === undefined ? {} : { githubAppMinter: input.githubAppMinter }),
      identitySecretRef: input.identitySecretRef,
      ...(input.claimClient === undefined ? {} : { claimClient: input.claimClient }),
      ...(input.runStateWriter === undefined ? {} : { runStateWriter: input.runStateWriter }),
    },
    { concurrency: input.concurrency, notifyListener, ...input.options },
  );
  worker.start();
  // P3-0028: a co-located reaper recovers leases dropped by crashed workers.
  // Plane-split P3b: the reaper's dead-letter `events` append is the one worker
  // event-write OUTSIDE the run executor, so when remote-writes is on it must
  // ALSO route through the control plane — otherwise the de-privileged
  // `tanren_dataplane` role (which has NO `events` grant) would be denied the
  // INSERT. The `RunStateWriter` IS an `EventStore`, so inject it as the reaper's
  // event store; left direct (the default) it keeps the in-process append.
  const reaper = new JobReaper({
    pool: input.pool,
    jobQueue,
    ...(input.runStateWriter === undefined ? {} : { eventStore: input.runStateWriter }),
  });
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
