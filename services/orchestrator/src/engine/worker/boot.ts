// Plane-split P1: shared run-executor worker boot. Builds the same
// pools/secrets/allocator/ssh/github wiring the in-process boot used, seeds the
// runner identity secret, and starts the worker loop. Used by BOTH the
// in-process flag path (main.ts, TANREN_RUN_WORKER=1) and the standalone
// `worker-main.ts` entrypoint (the data-plane container). The worker is now a
// standalone deployable; this is the single construction site so the two paths
// can never drift. See docs/roadmap/saas-rls-and-plane-split-plan.md (P1).

import { readFile } from "node:fs/promises";
import { createDbPool } from "@tanren/db";
import type pg from "pg";
import { buildAllocatorFromEnv } from "../allocators/index.js";
import { resolveWorkerConcurrency } from "../config/index.js";
import { buildSecretStore, type SecretStore } from "../contracts/index.js";
import { startAutonomyLoops, type AutonomyLoops } from "./autonomyLoops.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "../observability/index.js";
import { buildVcsProvider, FetchGitHubHttpClient } from "../providers/buildVcsProvider.js";
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
   * The autonomy background loops (autonomy-engine.md §1a + §1d): the DagWalker
   * subscriber that turns the spec DAG into self-driving execution, plus the
   * autonomous-intake loops (webhook-fallback poller + the now-on-a-loop audit
   * scheduler) that ingest issues/signals and auto-route into the DAG/inbox.
   * Co-located with the worker boot because they share the runtime pool + the
   * same executor + allocator.
   */
  autonomy: AutonomyLoops;
  /** Drain the worker + reaper + autonomy loops (the SIGTERM path). */
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
  // Hoisted so the run worker AND the P1d intake poller share the same allocator /
  // SSH / GitHub plumbing (the poller's triage answerer allocates a runner per
  // model call exactly as the Forge route factories do).
  const allocator = buildAllocatorFromEnv(pool);
  const ssh = new TimedSshSubstrate(new Ssh2Substrate(secrets));
  const githubHttp = new TimedGitHubHttpClient(new FetchGitHubHttpClient());
  // P2·0: the run/merge lifecycle routes its VCS/CI ops through the VcsProvider
  // seam (registry default = the real GitHub impl composing `githubHttp`).
  const vcsProvider = buildVcsProvider(githubHttp);
  const { worker, reaper } = startRunWorker({
    pool,
    concurrency,
    allocator,
    // Same boundary-timing wrappers as the HTTP-server worker path; the worker
    // internals are untouched, only its injected SSH / GitHub clients decorated.
    ssh,
    secrets,
    vcsProvider,
    identitySecretRef,
    ...(claimClient === undefined ? {} : { claimClient }),
    ...(runStateWriter === undefined ? {} : { runStateWriter }),
  });
  // Autonomy engine §1a + §1d: start the worker's autonomy background loops — the
  // per-project DagWalker (subscribes to the run-activity bus and self-drives the
  // DAG: on every terminal-run / merge.completed it enqueues ready specs THIS
  // worker then executes) and the autonomous-intake loops (the webhook-fallback
  // poller + the now-on-a-loop audit scheduler, both auto-routing into the
  // DAG/inbox). The driver becomes autonomous; no operator triggers each spec.
  const autonomy = await startAutonomyLoops({ pool, secrets, allocator, ssh, githubHttp, identitySecretRef });
  const stop = async (): Promise<void> => {
    await autonomy.stop();
    await Promise.all([worker.stop(), reaper.stop()]);
  };
  return { worker, reaper, pool, secrets, autonomy, stop };
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
