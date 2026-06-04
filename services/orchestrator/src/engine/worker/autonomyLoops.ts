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
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildPercolationCoordinator } from "../dag/percolationBuild.js";
import { buildSpecStrandReconciler } from "../dag/specStrandReconcilerPg.js";
import { PgSpeculativeIntegrator } from "../dag/speculativeIntegrator.js";
import { startDagWalkerSubscriber } from "../dag/subscriber.js";
import { startMergeCoordinatorSubscriber } from "../merge/subscriber.js";
import { startPostMergeSubscriber } from "../postMerge/subscriber.js";
import { buildDeployOnMergeWatcher, buildDemoOnDeployWatcher } from "../postMerge/deployOnMerge.js";
import { startIntake } from "../forge/intake/bootIntake.js";
import { buildCiInsightsLoop } from "./buildCiInsightsLoop.js";
import { buildNotificationDispatcher } from "../notifications/build.js";
import { startNotificationSubscriber } from "../notifications/subscriber.js";
import type { DagWalkerSubscriber } from "../dag/subscriber.js";
import type { MergeCoordinatorSubscriber } from "../merge/subscriber.js";
import type { PostMergeSubscriber } from "../postMerge/subscriber.js";
import type { BootedIntake } from "../forge/intake/bootIntake.js";
import type { CiInsightsLoop } from "./ciInsightsLoop.js";
import type { NotificationSubscriber } from "../notifications/subscriber.js";

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
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on, plane-split P3), EVERY tenant write the loops drive — the
   * DagWalker's run-creation + dag.* events, the merge coordinator's merge-stage
   * writes + spec-status + conflict re-exec, the post-merge watcher's events, and
   * the intake's run/spec creation — routes through the control plane over mTLS
   * (the de-privileged data-plane role can no longer write those tables directly).
   * Absent (single-role dev), the loops write the tenant tables directly via
   * `deps.pool` — byte-identical to today. Mirrors the run executor's seam.
   */
  runStateWriter?: RunStateWriter;
}

export interface AutonomyLoops {
  dagWalker: DagWalkerSubscriber;
  /** P2d: the native merge queue coordinator subscriber. */
  mergeCoordinator: MergeCoordinatorSubscriber;
  /** tempering.md dim A: the post-merge-failure → auto-issue watcher subscriber. */
  postMerge: PostMergeSubscriber;
  /**
   * The notification dispatcher subscriber: wakes on EVERY appended event
   * (`tanren_notify`) and fans high-signal events out to the configured channels
   * — the wiring that makes `dag.spec.needs_attention` (and every fail-severity
   * escalation) actually reach a human.
   */
  notifications: NotificationSubscriber;
  intake: BootedIntake;
  /**
   * CI-intelligence PR2: the flaky+duration detector ON A LOOP. It runs the
   * quarantine detection on a cadence (NOT on the dashboard GET), so the merge
   * gate's quarantine read has fresh quarantines without an operator opening a page.
   */
  ciInsights: CiInsightsLoop;
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
    // Plane-split: route the change-percolation coordinator's run-column writes +
    // spec reopen + re-execution run-CREATE + events through the control plane when
    // wired; else direct on the pool (byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  // NEVER-STRAND safety net: the strand reconciler runs LAST in the walk chain (walk
  // → percolate → reconcile) + on a low-frequency periodic backstop, re-enqueuing any
  // spec stuck OCCUPYING A SLOT with no live run (the recurring stranding bug) with
  // bounded escalation to needs_attention. It makes the DAG self-heal from EVERY
  // stranding cause, not just the §2c re-exec halt percolation can catch.
  const reconciler = buildSpecStrandReconciler({
    pool: deps.pool,
    // Plane-split: route the reconciler's spec flip + marker clear + events through
    // the control plane when wired; else direct on the pool (byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  const dagWalker = await startDagWalkerSubscriber({
    pool: deps.pool,
    notifyListener: dagNotifyListener,
    integrator,
    percolation,
    reconciler,
    // Plane-split: the walker's run-creation + dag.* events route through the
    // control plane when wired (else direct on deps.pool, byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
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
    // The drive-path conflict resolver provisions a short-lived runner + workspace to
    // run the REAL intent-preserving resolver (the blind-re-exec stub is gone). The
    // allocator/ssh/identity are the SAME the intake + run executor use.
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    // Plane-split: the coordinator's merge-stage writes (events/tasks/runs/specs),
    // its spec-status finalize, and its conflict resolver's replan write route
    // through the control plane when wired (else direct on deps.pool, byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  console.log("[run-worker] native merge-queue coordinator subscriber started (autonomy-engine §2d)");
  // tempering.md dim A: the post-merge watcher reacts on the SAME run-activity bus —
  // once a run's PR merges onto default_branch it reads the post-merge CI on the base
  // branch and auto-opens ONE tracking issue on a genuine failure. Its own LISTEN
  // connection so it never contends with the walker's / coordinator's notify pumps.
  const postMergeNotifyListener = new PgNotifyListener(deps.pool);
  // Deploy-on-merge ("a deploy happened"): on the SAME merge.completed wake, a
  // project with a deploy integration gets its merged commit built + released onto
  // its Vercel/Fly app + its runtime env attached. A project with no deploy target
  // is a clean no-op; a configured deploy that fails is LOUD (logged, isolated).
  const deployWatcher = buildDeployOnMergeWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  // Demos-as-evidence: on the SAME wake, AFTER the deploy is verified, exercise the
  // spec's behaviors against the live deploy surface + record per-behavior evidence.
  // A run with no verified deploy is a clean no-op.
  const demoWatcher = buildDemoOnDeployWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  const postMerge = await startPostMergeSubscriber({
    pool: deps.pool,
    notifyListener: postMergeNotifyListener,
    secrets: deps.secrets,
    vcsProvider: deps.vcsProvider,
    deployWatcher,
    demoWatcher,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    // Plane-split: the watcher's post-merge events route through the control plane
    // when wired (else direct on deps.pool, byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  console.log("[run-worker] post-merge auto-issue + deploy-on-merge watcher subscriber started (tempering.md dim A)");
  // Notifications: build the dispatcher ONCE (channel registry with the real
  // channel deps — `secrets` resolves Slack/webhook/etc. write-only credential
  // refs; the shared App minter authenticates github_checks) + the code-level default
  // route, then start the subscriber. It wakes on the `tanren_notify` bus — fired
  // at the event-append seam for EVERY event — and fans each event through the
  // dispatcher's matrix + severity filter. This is what makes escalations real:
  // `dag.spec.needs_attention` (project-scoped, no run id ⇒ no `tanren_run` wake)
  // reaches a human only because notifications key off the every-event channel.
  // Its own LISTEN connection so it never contends with the other notify pumps.
  const notificationNotifyListener = new PgNotifyListener(deps.pool);
  const dispatcher = buildNotificationDispatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  const notifications = await startNotificationSubscriber({
    pool: deps.pool,
    notifyListener: notificationNotifyListener,
    dispatcher,
  });
  console.log("[run-worker] notification dispatcher subscriber started (events now reach humans)");
  const intake = startIntake({
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    githubHttp: deps.githubHttp,
    // The shared App-token minter: the poller's per-org issues connector mints an
    // installation token (App-only intake), and the audit pass runner resolves a repo-read token.
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    identitySecretRef: deps.identitySecretRef,
    // Plane-split: the intake auto-route's spec/run creation routes through the
    // control plane when wired (else direct on deps.pool, byte-identical).
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  console.log("[run-worker] intake poller + audit scheduler loops started (autonomy-engine §1d)");
  // CI-intelligence PR2+PR3: the flaky+duration detector on a cadence (replaces the
  // dashboard-GET-on-read trigger). Each tick quarantines proven-flaky checks/tests
  // so the merge gate's quarantine read excludes them (PR2), THEN turns each genuine
  // recurring problem into an auto-routed root-cause fix-spec that ships through the
  // inbox auto-route spine (PR3) — autonomous, no operator GET. Built via the factory
  // so this composition root stays under the runtime-import cap.
  const ciInsights = buildCiInsightsLoop({
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  console.log(
    "[run-worker] CI-insights detect+quarantine + generative root-cause loop started (CI-intelligence PR2+PR3)",
  );
  const stop = async (): Promise<void> => {
    dagWalker.stop();
    mergeCoordinator.stop();
    postMerge.stop();
    notifications.stop();
    intake.stop();
    ciInsights.stop();
    await dagNotifyListener.close();
    await mergeNotifyListener.close();
    await postMergeNotifyListener.close();
    await notificationNotifyListener.close();
  };
  return { dagWalker, mergeCoordinator, postMerge, notifications, intake, ciInsights, stop };
}
