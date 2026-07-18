// The run-worker lifecycle helpers — `startRunWorker`
// (build + start the worker and its co-located reaper, install graceful-drain
// signal handlers + the process-level resilience net that keeps the worker alive
// on a stray per-run unhandledRejection/uncaughtException) and the
// `runWorkerEnabled()` flag gate.
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
// Likewise re-exported here: the run-sandbox reaper is another co-located worker
// reaper (this module's header owns "start the worker and its co-located reaper"), so
// boot starts it from this same module — no new boot import-dependency.
export { startRunWorkspaceReaper } from "./buildRunWorkspaceReaper.js";
export type { RunWorkspaceReaper } from "./runWorkspaceReaper.js";
// Task #9: the runner-row orphan sweeper is the third co-located worker
// reconciler (alongside the run-workspace reaper + the job reaper). Re-exported
// from here so the worker boot starts it without a new import dependency.
export { startRunnerRowOrphanSweeper } from "./buildRunnerRowOrphanSweeper.js";
export type { RunnerRowOrphanSweeper } from "./buildRunnerRowOrphanSweeper.js";
// apex-v96 guard: the Fly-machine orphan sweeper is another co-located worker
// reconciler (durable out-of-band reap of accumulated Fly machines). Re-exported
// here so the worker boot starts it without a new import dependency.
export { startFlyMachineOrphanSweeper } from "./buildFlyMachineOrphanSweeper.js";
export type { FlyMachineOrphanSweeper } from "./buildFlyMachineOrphanSweeper.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { GithubReviewerAppIdentity } from "../governance/githubReviewerAppIdentity.js";
import { RepositoryVisibilityRunAdmission } from "../governance/repositoryVisibilityAdmission.js";
import { createLogger } from "../observability/logger.js";
import { JobReaper } from "./jobReaper.js";
import { RunWorker, type RunWorkerOptions } from "./runWorker.js";
import { buildEnvCreationFromEnv, type EnvCreationDeps } from "../environments/creation/index.js";

// Re-exported so the worker boot builds the JIT env-creation seams (env-management.md
// §4 + §7 P4) without taking a direct dependency on the env-creation module (keeping
// boot.ts under its import-dependency cap). The seams are gated on TANREN_ENV_REGISTRY.
export { buildEnvCreationFromEnv };

const log = createLogger("run-worker");

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
  /** The shared (timed) GitHub HTTP client every run/merge host seam is built over. */
  githubHttp: GitHubHttpClient;
  // Part 2: shared App installation-token minter (cache lives here),
  // threaded to the workflow so the App-first clone reuses it. Optional — the
  // standalone resolver mints a per-call minter when absent.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  // Concurrency is a GOVERNED CONFIG KNOB, never an env var (autonomy-engine.md
  // §1.4): the max in-flight run slots this worker maintains. Sourced from the
  // config surface's `AllocatorConfig.concurrency` (boot resolves it), so a
  // spend-rate change is config, not a redeploy. The future DagWalker reads the
  // same per-project/org ceiling and throttles BELOW it on live signals.
  concurrency: number;
  // How the worker CLAIMS. Omit for the direct DB-CAS over a
  // `PgJobQueue` (the in-process / single-process path); the cross-process
  // `worker` container passes an `HttpJobClaimClient` that claims over the mTLS
  // control-plane endpoint.
  claimClient?: JobClaimClient;
  // REQUIRED (audit finding D3/H3 sweep): the workflow's atomic terminal
  // seams require this writer everywhere. Default in-process (the
  // `DirectRunStateWriter` constructed by `buildRunStateWriterFromEnv(pool)`,
  // byte-identical to the prior direct path); the cross-process `worker`
  // container resolves it to an `HttpRunStateWriter` over mTLS when
  // TANREN_DATA_PLANE_REMOTE_WRITES=1.
  runStateWriter: RunStateWriter;
  // Environment management (env-management.md §4 + §7 P4): the JIT env-image creation
  // seams threaded to the executor. Wired ⇒ an off-baseline no-match run synchronously
  // builds→validates→publishes a real env image before seeding. Omitted ⇒ P3's
  // golden-base no-match fallback (byte-identical).
  envCreation?: EnvCreationDeps;
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
      githubHttp: input.githubHttp,
      ...(input.githubAppMinter === undefined ? {} : { githubAppMinter: input.githubAppMinter }),
      repositoryVisibilityAdmission: new RepositoryVisibilityRunAdmission(
        input.pool,
        new GithubReviewerAppIdentity({
          pool: input.pool,
          secrets: input.secrets,
          http: input.githubHttp,
          ...(input.githubAppMinter === undefined ? {} : { minter: input.githubAppMinter }),
        }),
      ),
      identitySecretRef: input.identitySecretRef,
      ...(input.claimClient === undefined ? {} : { claimClient: input.claimClient }),
      runStateWriter: input.runStateWriter,
      ...(input.envCreation === undefined ? {} : { envCreation: input.envCreation }),
    },
    { concurrency: input.concurrency, notifyListener, ...input.options },
  );
  worker.start();
  // a co-located reaper recovers leases dropped by crashed workers.
  // the reaper's dead-letter `events` append is the one worker
  // event-write OUTSIDE the run executor, so when remote-writes is on it must
  // ALSO route through the control plane — otherwise the de-privileged
  // `tanren_dataplane` role (which has no `events` write grant) would be denied the
  // INSERT. The `RunStateWriter` IS an `EventStore`, so inject it as the reaper's
  // event store; left direct (the default) it keeps the in-process append.
  const reaper = new JobReaper({
    pool: input.pool,
    jobQueue,
    eventStore: input.runStateWriter,
  });
  reaper.start();
  installSignalHandlers(worker, reaper);
  installResilienceHandlers();
  return { worker, reaper };
}

let signalHandlersInstalled = false;
let resilienceHandlersInstalled = false;

/**
 * Last-line resilience net: keep the worker process ALIVE on an
 * `unhandledRejection` / `uncaughtException`. The worker serves EVERY run, so a
 * single per-run data error (the v25-apex case: an invalid built-repo
 * `.tanren/ci.yml` whose validation rejection escaped as an unobserved promise →
 * the process exited status 1, crash-looping the shared worker; same class as the
 * v21 ssh2-'error' crash #342) must NEVER take down the process. The structured
 * per-run boundaries (the gate-config fail-closed path, `executeNextPlanJob`'s
 * catch, `runSlot`'s catch) are the PRIMARY defense — this net only catches a
 * STRAY throw they missed and surfaces it LOUDLY (no silent swallow) so it is
 * fixed, while the worker keeps claiming + executing other jobs. Installed once.
 *
 * Deliberately does NOT exit: Node's default since v15 terminates on an unhandled
 * rejection, which is exactly the crash we are hardening against. A genuinely
 * unrecoverable fault still surfaces (loud log + the affected run's own
 * finalize/heartbeat-lapse recovery); a transient per-run fault no longer wedges
 * the queue for every other tenant.
 */
function installResilienceHandlers(): void {
  if (resilienceHandlersInstalled) {
    return;
  }
  resilienceHandlersInstalled = true;
  process.on("unhandledRejection", (reason: unknown) => {
    log.error(
      "UNHANDLED REJECTION (worker SURVIVES — a stray per-run error escaped its boundary; the affected run recovers via finalize/lease-lapse)",
      {},
      reason,
    );
  });
  process.on("uncaughtException", (error: unknown) => {
    log.error(
      "UNCAUGHT EXCEPTION (worker SURVIVES — a stray per-run error escaped its boundary; the affected run recovers via finalize/lease-lapse)",
      {},
      error,
    );
  });
}

/**
 * Drain the worker + reaper on a shutdown signal, then exit with a FAIL-CLOSED
 * code: a CLEAN drain exits 0; a drain that REJECTED (a `stop()` threw mid-
 * teardown) exits NON-ZERO so the supervisor treats the shutdown as failed and
 * RESTARTS the worker — never a silent `exit(0)` that masks a wedged drain.
 *
 * Exported (with an injectable `exit` for the test) so the exit-code decision can
 * be asserted directly without installing a real signal handler.
 */
export async function drainWorkerAndExit(
  worker: Pick<RunWorker, "stop">,
  reaper: Pick<JobReaper, "stop">,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    await Promise.all([worker.stop(), reaper.stop()]);
    exit(0);
  } catch (error: unknown) {
    log.error("drain failed — exiting non-zero so the supervisor restarts", {}, error);
    exit(1);
  }
}

/** Wire SIGTERM/SIGINT to drain the worker + reaper, then exit. Installed once. */
function installSignalHandlers(worker: RunWorker, reaper: JobReaper): void {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  const drain = (signal: NodeJS.Signals) => {
    log.info(`${signal} received — draining in-flight jobs`, { signal });
    void drainWorkerAndExit(worker, reaper);
  };
  process.once("SIGTERM", () => drain("SIGTERM"));
  process.once("SIGINT", () => drain("SIGINT"));
}
