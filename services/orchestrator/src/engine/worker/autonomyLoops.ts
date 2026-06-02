// The worker's autonomy background loops, assembled in one place so the worker
// boot wires them with a single dependency: the DagWalker subscriber
// (autonomy-engine.md §1a — turns the spec DAG into self-driving execution) and
// the autonomous-intake loops (§1d — the webhook-fallback poller + the
// now-on-a-loop scheduled-audit scheduler). All three react to the live system
// (the LISTEN/NOTIFY bus for the walker; per-source/cadence intervals for intake)
// and need no operator trigger.

import type pg from "pg";
import { PgNotifyListener } from "@tanren/db";
import type { Allocator } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildPercolationCoordinator } from "../dag/percolationBuild.js";
import { PgSpeculativeIntegrator } from "../dag/speculativeIntegrator.js";
import { startDagWalkerSubscriber } from "../dag/subscriber.js";
import { startMergeCoordinatorSubscriber } from "../merge/subscriber.js";
import { startIntake } from "../forge/intake/bootIntake.js";
import type { DagWalkerSubscriber } from "../dag/subscriber.js";
import type { MergeCoordinatorSubscriber } from "../merge/subscriber.js";
import type { BootedIntake } from "../forge/intake/bootIntake.js";

export interface AutonomyLoopsDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  githubHttp: GitHubHttpClient;
  identitySecretRef: string;
  /** P2c-1: the VcsProvider the speculative integrator drives to build integration branches. */
  vcsProvider: VcsProvider;
  /** P2c-1: the shared App-token minter the integrator reuses for the integration push. */
  githubAppMinter?: GithubAppTokenMinter;
}

export interface AutonomyLoops {
  dagWalker: DagWalkerSubscriber;
  /** P2d: the native merge queue coordinator subscriber. */
  mergeCoordinator: MergeCoordinatorSubscriber;
  intake: BootedIntake;
  /** Drain every autonomy loop (the SIGTERM path); idempotent. */
  stop: () => Promise<void>;
}

/**
 * Start the worker's autonomy loops. The DagWalker subscribes to the run-activity
 * bus and self-drives the DAG; the intake loops ingest issues/signals (webhook
 * fallback poller + audit scheduler) and auto-route into the DAG/inbox. Returns
 * the handles so the boot's `stop()` tears them all down.
 */
export async function startAutonomyLoops(deps: AutonomyLoopsDeps): Promise<AutonomyLoops> {
  const dagNotifyListener = new PgNotifyListener(deps.pool);
  const integrator = new PgSpeculativeIntegrator({
    pool: deps.pool,
    vcsProvider: deps.vcsProvider,
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  // P2c-2: the change-percolation coordinator runs on the SAME notifications as
  // the walker — when an ancestor changes under an in-flight speculative dependent,
  // it percolates the delta down the chain (rebuild → re-base → re-gate) rather
  // than discarding the dependent's work.
  const percolation = buildPercolationCoordinator({
    pool: deps.pool,
    vcsProvider: deps.vcsProvider,
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  const dagWalker = await startDagWalkerSubscriber({
    pool: deps.pool,
    notifyListener: dagNotifyListener,
    integrator,
    percolation,
  });
  console.log(
    "[run-worker] DagWalker + change-percolation subscriber started (autonomous DAG execution + §2c percolation)",
  );
  // P2d: the native intelligent merge queue. It reacts on the SAME run-activity bus
  // — a ready `native_queue` run entering the queue, and a merge completing — and
  // merges ONE entry at a time in DAG order (ancestor before dependent), driving the
  // existing per-run merge path. Its own LISTEN connection so it never contends with
  // the walker's notify pump.
  const mergeNotifyListener = new PgNotifyListener(deps.pool);
  const mergeCoordinator = await startMergeCoordinatorSubscriber({
    pool: deps.pool,
    notifyListener: mergeNotifyListener,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  console.log("[run-worker] native merge-queue coordinator subscriber started (autonomy-engine §2d)");
  const intake = startIntake({
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    githubHttp: deps.githubHttp,
    identitySecretRef: deps.identitySecretRef,
  });
  console.log("[run-worker] intake poller + audit scheduler loops started (autonomy-engine §1d)");
  const stop = async (): Promise<void> => {
    dagWalker.stop();
    mergeCoordinator.stop();
    intake.stop();
    await dagNotifyListener.close();
    await mergeNotifyListener.close();
  };
  return { dagWalker, mergeCoordinator, intake, stop };
}
