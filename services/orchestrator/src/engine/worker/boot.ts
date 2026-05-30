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
import { buildSecretStore, type SecretStore } from "../contracts/index.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "../observability/index.js";
import { FetchGitHubHttpClient } from "../providers/github.js";
import { Ssh2Substrate } from "../ssh/index.js";
import { buildClaimClientFromEnv } from "./claimClientFromEnv.js";
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
  /** Drain the worker + reaper (the SIGTERM path); used by tests/owned shutdown. */
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
  const { worker, reaper } = startRunWorker({
    pool,
    allocator: buildAllocatorFromEnv(pool),
    // Same boundary-timing wrappers as the HTTP-server worker path; the worker
    // internals are untouched, only its injected SSH / GitHub clients decorated.
    ssh: new TimedSshSubstrate(new Ssh2Substrate(secrets)),
    secrets,
    githubHttp: new TimedGitHubHttpClient(new FetchGitHubHttpClient()),
    identitySecretRef,
    ...(claimClient === undefined ? {} : { claimClient }),
  });
  const stop = async (): Promise<void> => {
    await Promise.all([worker.stop(), reaper.stop()]);
  };
  return { worker, reaper, pool, secrets, stop };
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
