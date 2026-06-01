// Plane-split P1: shared run-executor worker boot. Builds the same
// pools/secrets/allocator/ssh/github wiring the in-process boot used, seeds the
// runner identity secret, and starts the worker loop. Used by BOTH the
// in-process flag path (main.ts, TANREN_RUN_WORKER=1) and the standalone
// `worker-main.ts` entrypoint (the data-plane container). The worker is now a
// standalone deployable; this is the single construction site so the two paths
// can never drift. See docs/roadmap/saas-rls-and-plane-split-plan.md (P1).

import { readFile } from "node:fs/promises";
import { createDbPool, PgNotifyListener } from "@tanren/db";
import type pg from "pg";
import { buildAllocatorFromEnv } from "../allocators/index.js";
import { resolveWorkerConcurrency } from "../config/index.js";
import { buildSecretStore, type SecretStore } from "../contracts/index.js";
import { startDagWalkerSubscriber, type DagWalkerSubscriber } from "../dag/subscriber.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "../observability/index.js";
import { FetchGitHubHttpClient } from "../providers/github.js";
import { Ssh2Substrate } from "../ssh/index.js";
import { buildClaimClientFromEnv } from "./claimClientFromEnv.js";
import { buildRunStateWriterFromEnv } from "./runStateWriterFromEnv.js";
import type { JobReaper } from "./jobReaper.js";
import type { RunWorker } from "./runWorker.js";
import { startRunWorker } from "./lifecycle.js";

/** What {@link bootRunWorker} returns so callers (and tests) can drain + assert. */
export interface BootedRunWorker {
  worker: RunWorker;
  reaper: JobReaper;
  /** The runtime (`tanren_app`) pool the worker claims + writes through. */
  pool: pg.Pool;
  secrets: SecretStore;
  /**
   * The DagWalker subscriber (autonomy-engine.md §1a): the per-project background
   * scheduler that turns the spec DAG into self-driving execution. It listens on
   * the SAME run-activity bus the worker writes to and enqueues ready specs
   * through createQueuedRunFromSpec — the worker then runs them. Co-located with
   * the worker boot because it shares the runtime pool + drives the same executor.
   */
  dagWalker: DagWalkerSubscriber;
  /** Drain the worker + reaper + DAG subscriber (the SIGTERM path). */
  stop: () => Promise<void>;
}

/**
 * Build the run-executor worker's dependencies from the environment and start
 * its claim→plan→write→check→audit loop.
 *
 * Pools mirror the API exactly: the runtime pool is `createDbPool()`
 * (`DATABASE_URL`, the restricted `tanren_app` role under R3b); the BYPASSRLS
 * `tanren_system` pool is resolved lazily by `runWithSystemScope`/the reaper from
 * `TANREN_SYSTEM_DATABASE_URL`. P1 is a process-boundary change ONLY — the worker
 * still claims directly from `job_queue` (DB-CAS, unchanged); P2 moves the claim
 * behind a control-plane API and adds mTLS, P3 de-privileges the data plane.
 *
 * Does NOT run migrations: the control-plane API owns the migrate step (the
 * worker container `depends_on` it), and the in-process flag path already
 * migrated in `createApp` before this runs.
 */
export async function bootRunWorker(): Promise<BootedRunWorker> {
  const identitySecretRef = process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] ?? "runner/local-docker/identity";
  const pool = createDbPool();
  const secrets = buildSecretStore();
  await seedRunnerIdentitySecret(secrets, identitySecretRef);
  // Plane-split P2: when the control-plane claim endpoint + the data-plane mTLS
  // certs are configured, claim over the mTLS endpoint (so this container never
  // touches `job_queue` to claim); else fall back to the direct DB-CAS. The
  // standalone `worker` container sets the endpoint env; the single-process dev
  // path leaves it unset and claims directly.
  const claimClient = buildClaimClientFromEnv();
  console.log(
    claimClient === undefined
      ? "[run-worker] claiming via direct DB-CAS (no control-plane endpoint configured)"
      : "[run-worker] claiming via the mTLS control-plane endpoint (plane-split P2)",
  );
  // Plane-split P3: when TANREN_DATA_PLANE_REMOTE_WRITES=1 (+ endpoint + certs),
  // route the worker's run-state WRITES through the control plane over mTLS; else
  // the worker writes the tenant tables directly (the default, reversible).
  const runStateWriter = buildRunStateWriterFromEnv();
  console.log(
    runStateWriter === undefined
      ? "[run-worker] writing run state via direct in-process DB writes (remote-writes off)"
      : "[run-worker] writing run state via the mTLS control-plane endpoints (plane-split P3)",
  );
  // Concurrency is a GOVERNED CONFIG KNOB, not an env var (autonomy-engine.md
  // §1.4): resolve the worker's slot ceiling from the config surface's
  // `AllocatorConfig.concurrency`. The future DagWalker reads the same
  // per-project/org ceiling and throttles below it on live signals.
  const concurrency = resolveWorkerConcurrency();
  console.log(`[run-worker] concurrency ceiling = ${concurrency} (config: allocator.concurrency)`);
  const { worker, reaper } = startRunWorker({
    pool,
    concurrency,
    allocator: buildAllocatorFromEnv(pool),
    // Same boundary-timing wrappers as the HTTP-server worker path; the worker
    // internals are untouched, only its injected SSH / GitHub clients decorated.
    ssh: new TimedSshSubstrate(new Ssh2Substrate(secrets)),
    secrets,
    githubHttp: new TimedGitHubHttpClient(new FetchGitHubHttpClient()),
    identitySecretRef,
    ...(claimClient === undefined ? {} : { claimClient }),
    ...(runStateWriter === undefined ? {} : { runStateWriter }),
  });
  // Autonomy engine §1a: start the per-project DagWalker as a long-lived
  // subscriber on the SAME LISTEN/NOTIFY run-activity bus the worker writes to. On
  // startup + on every terminal-run / merge.completed notification it loads the
  // spec DAG under RLS, computes the ready set (deps all done), and enqueues up to
  // the governed concurrency headroom of ready specs via createQueuedRunFromSpec —
  // which THIS worker then executes. The driver becomes autonomous; no operator
  // triggers each spec.
  const dagNotifyListener = new PgNotifyListener(pool);
  const dagWalker = await startDagWalkerSubscriber({ pool, notifyListener: dagNotifyListener });
  console.log("[run-worker] DagWalker subscriber started (autonomous DAG execution, autonomy-engine §1a)");
  const stop = async (): Promise<void> => {
    dagWalker.stop();
    await dagNotifyListener.close();
    await Promise.all([worker.stop(), reaper.stop()]);
  };
  return { worker, reaper, pool, secrets, dagWalker, stop };
}

/**
 * Seed the runner SSH identity into the secret store (the same Vault the API
 * uses), from the inline private key or a key file. A no-op when neither env is
 * set (the API may have already seeded it; they share the store). Mirrors
 * `main.ts`'s `seedRunnerIdentitySecret` so the standalone worker is
 * self-contained.
 */
async function seedRunnerIdentitySecret(secrets: SecretStore, ref: string): Promise<void> {
  const inlinePrivateKey = process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
  if (inlinePrivateKey !== undefined && inlinePrivateKey !== "") {
    await secrets.put({ ref, value: inlinePrivateKey });
    return;
  }
  const keyPath = process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
  if (keyPath !== undefined && keyPath !== "") {
    await secrets.put({ ref, value: await readFile(keyPath, "utf8") });
  }
}
