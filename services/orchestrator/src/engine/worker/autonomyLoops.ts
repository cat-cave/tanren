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
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildPercolationCoordinator, buildResolutionDagWalker } from "../dag/build.js";
import { createLogger, startDagWalkerSubscriber } from "../dag/subscriber.js";
import { startMergeCoordinatorSubscriber, attemptDerivingActivation } from "../merge/subscriber.js";
import {
  startPostMergeSubscriber,
  buildDeployOnMergeWatcher,
  buildDemoOnDeployWatcher,
  buildDeliveryDagDriver,
  buildMergeTrainArtifactWatcher,
  buildDesignAwareDeliveryCoordinator,
  buildLandGroupDeliveryLoop,
  type CasByteStore,
} from "../postMerge/subscriber.js";
import { buildFlyImageBuilderFromEnv } from "../provisioners/flyImageBuilderConfig.js";
import { startIntake } from "../forge/intake/bootIntake.js";
import { buildCiInsightsLoop } from "./buildCiInsightsLoop.js";
import { startPausedRunResumeProber, type PausedRunResumeProber } from "../usage/pausedRunResumeProber.js";
import type { DagWalkerSubscriber } from "../dag/subscriber.js";
import type { MergeCoordinatorSubscriber } from "../merge/subscriber.js";
import type { PostMergeSubscriber } from "../postMerge/subscriber.js";
import type { BootedIntake } from "../forge/intake/bootIntake.js";
import { buildSourceSyncWorker } from "./sourceSyncWorkerBuild.js";
import { startWorkerNotifications } from "./notificationAutonomy.js";
import { PgProofSubstrate, PgCasByteStore, PROOF_SIGNING_KEY_REF, resolveSigningKey } from "../cas/pgProofSubstrate.js";

const log = createLogger("run-worker");

export interface AutonomyLoopsDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: CommandSubstrate;
  /** the shared GitHub HTTP client the merge coordinator + base-shift live seams build over. */
  githubHttp: GitHubHttpClient;
  identitySecretRef: string;
  /** the shared App-token minter the base-shift live seams reuse for authed pushes/fetches. */
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on, full de-privilege), EVERY tenant write the loops drive — the
   * DagWalker's run-creation + dag.* events, the merge coordinator's merge-stage
   * writes + spec-status + conflict re-exec, the post-merge watcher's events,
   * and the intake's run/spec creation — routes through this writer. Audit
   * finding D3/H3 sweep: REQUIRED. Default is the in-process
   * `DirectRunStateWriter` (byte-identical to the prior direct path); the
   * cross-process `worker` container resolves it to an `HttpRunStateWriter`
   * over mTLS when TANREN_DATA_PLANE_REMOTE_WRITES=1.
   */
  runStateWriter: RunStateWriter;
}

export interface AutonomyLoops {
  dagWalker: DagWalkerSubscriber;
  /** Durable self-healing stage dispatcher; periodic scan backs up notifications. */
  resolutionDagWalker: ReturnType<typeof buildResolutionDagWalker>;
  /** Durable provider mutation + readback worker for ResolutionAuthority outbox rows. */
  sourceSyncWorker: ReturnType<typeof buildSourceSyncWorker>;
  /** the native merge queue coordinator subscriber. */
  mergeCoordinator: MergeCoordinatorSubscriber;
  /** tempering.md dim A: the post-merge-failure → auto-issue watcher subscriber. */
  postMerge: PostMergeSubscriber;
  /**
   * The notification dispatcher subscriber: wakes on EVERY appended event
   * (`tanren_notify`) and fans high-signal events out to the configured channels
   * — the wiring that makes `dag.spec.needs_attention` (and every fail-severity
   * escalation) actually reach a human.
   */
  notifications: Awaited<ReturnType<typeof startWorkerNotifications>>["subscriber"];
  intake: BootedIntake;
  /**
   * CI-intelligence PR2: the flaky+duration detector ON A LOOP. It runs the
   * quarantine detection on a cadence (NOT on the dashboard GET), so the merge
   * gate's quarantine read has fresh quarantines without an operator opening a page.
   */
  ciInsights: ReturnType<typeof buildCiInsightsLoop>;
  /**
   * task #82 — window-pause auto-resume: the sign-of-life prober that finds
   * runs in the new non-terminal `paused` status (a `window_exhausted` writer
   * outcome flipped them there) and resumes them when their provider's usage
   * window refreshes. NOT a wall-clock waiter — capacity always returns,
   * unbounded. The resume flips the paused run to `halted` + re-opens the
   * spec, and the walker re-enqueues a successor; the new run's preflight is
   * the actual capacity test (re-pauses on a still-exhausted window).
   */
  pausedRunResumeProber: PausedRunResumeProber;
  /**
   * SP-3: the SOLE production `ProofSubstrate` (`PgProofSubstrate`), constructed
   * once here over the shared runtime pool + secret store. It is the canonical
   * proof-sealing/verification substrate the merge-train / gate-proof consumers
   * inject (e.g. mq-15's merge-train artifact watcher). It is ALWAYS constructed;
   * its signing key is resolved lazily from the platform secret ref, and a
   * consumer calling `seal`/`verify` without a provisioned key fails LOUD
   * (`ProofSigningKeyUnavailableError`) — never a silent no-op. Boot probes the
   * key once and logs whether sealing is live or pending provisioning.
   */
  proofSubstrate: PgProofSubstrate;
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
  // the change-percolation coordinator runs on the SAME notifications as
  // the walker — when an ancestor changes under an in-flight speculative dependent,
  // it percolates the delta down the chain (rebuild → re-base → re-gate) rather
  // than discarding the dependent's work.
  const percolation = buildPercolationCoordinator({
    pool: deps.pool,
    githubHttp: deps.githubHttp,
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    // Plane-split: route the change-percolation coordinator's run-column writes +
    // spec reopen + re-execution run-CREATE + events through the control plane when
    // wired; else direct on the pool (byte-identical).
    runStateWriter: deps.runStateWriter,
    // The LIVE base shift: the runner allocator + SSH substrate + identity ref (the SAME
    // the merge coordinator's drive resolver uses) so a base shift actually REBASES the
    // dependent's branch in place over jj + re-gates it. These are REQUIRED — absent, the
    // base-shift handler cannot drive a live runner and construction throws loud.
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  });
  // NEVER-STRAND by construction (tanren-owns-the-engine.md §7): the strand
  // reconciler is GONE. It was a safety net for the percolation cancel+recreate
  // bug-class — a spec left OCCUPYING A SLOT with no live run after its run was
  // superseded. S2's `BaseShiftCoordinator.rebaseOnto` is never-discard: a base
  // shift REBASES the dependent's EXISTING run/branch in place (keeping the row),
  // so a spec can no longer be stranded by cancel+recreate. The reconciler is
  // deleted, not fixed.
  const dagWalker = await startDagWalkerSubscriber({
    pool: deps.pool,
    notifyListener: dagNotifyListener,
    percolation,
    // Plane-split: the walker's run-creation + dag.* events route through the
    // control plane when wired (else direct on deps.pool, byte-identical).
    runStateWriter: deps.runStateWriter,
  });
  log.info("DagWalker + change-percolation subscriber started (autonomous DAG execution + §2c percolation)");
  const resolutionDagWalker = buildResolutionDagWalker(deps.pool);
  resolutionDagWalker.start();
  log.info("ResolutionDagWalker started (durable self-healing stage dispatch)");
  const sourceSyncWorker = buildSourceSyncWorker({
    pool: deps.pool,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
  });
  sourceSyncWorker.start();
  log.info("source-sync outbox worker started (provider mutation + readback reconciliation)");
  // the native intelligent merge queue. It reacts on the SAME run-activity bus
  // — a ready `native_queue` run entering the queue, and a merge completing — and
  // merges ONE entry at a time in DAG order (ancestor before dependent), driving the
  // existing per-run merge path. Its own LISTEN connection so it never contends with
  // the walker's notify pump.
  const mergeNotifyListener = new PgNotifyListener(deps.pool);
  const mergeCoordinator = await startMergeCoordinatorSubscriber({
    pool: deps.pool,
    notifyListener: mergeNotifyListener,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
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
    runStateWriter: deps.runStateWriter,
    // in-6: the merge subscriber ALREADY listens on `NOTIFICATION_CHANNEL` for
    // credential/grant events (the REAL producer — these events have real
    // emitters). Fire-and-forget the deriving-project activation wake for each
    // affected project so a grant that unblocks a required capability promotes
    // the project `deriving → active` exactly-once.
    attemptActivation: (projectId) => attemptDerivingActivation(deps.pool, projectId),
  });
  log.info("native merge-queue coordinator subscriber started (autonomy-engine §2d)");
  // tempering.md dim A: the post-merge watcher reacts on the SAME run-activity bus —
  // once a run's PR merges onto default_branch it reads the post-merge CI on the base
  // branch and auto-opens ONE tracking issue on a genuine failure. Its own LISTEN
  // connection so it never contends with the walker's / coordinator's notify pumps.
  const postMergeNotifyListener = new PgNotifyListener(deps.pool);
  // Deploy-on-merge ("a deploy happened"): on the SAME merge.completed wake, a
  // project with a deploy integration gets its merged commit built + released onto
  // its Vercel/Fly app + its runtime env attached. A project with no deploy target
  // is a clean no-op; a configured deploy that fails is LOUD (logged, isolated).
  // The merge-reflecting Fly image builder is constructed from env here (once, at boot)
  // so every Fly deploy builds the merged commit into registry.fly.io/<app>:<sha>.
  // Undefined when not opted in (TANREN_FLY_IMAGE_BUILDER unset) — a Fly deploy then
  // fails loud at trigger time unless the static-image escape hatch is on.
  const flyImageBuilder = buildFlyImageBuilderFromEnv({
    secrets: deps.secrets,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
  });
  const deployWatcher = buildDeployOnMergeWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    runStateWriter: deps.runStateWriter,
    ...(flyImageBuilder !== undefined && { flyImageBuilder }),
  });
  // Demos-as-evidence: on the SAME wake, AFTER the deploy is verified, exercise the
  // spec's behaviors against the live deploy surface + record per-behavior evidence.
  // A run with no verified deploy is a clean no-op.
  const demoWatcher = buildDemoOnDeployWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    runStateWriter: deps.runStateWriter,
  });
  // in-17 durable post-merge DELIVERY DAG: consumes the in-16 `delivery_runs` outbox and
  // drives reconcile → lease → materialize → attach → deploy → verify → stimulate → observe
  // → record-evidence, resuming from the last durable stage. The deploy/demo watchers above
  // are its internal, idempotent stage runners — this REPLACES the old fixed deploy → demo
  // chain the subscriber used to sequence directly.
  const deliveryDriver = buildDeliveryDagDriver({
    pool: deps.pool,
    secrets: deps.secrets,
    deployWatcher,
    demoWatcher,
    runStateWriter: deps.runStateWriter,
  });
  // SP-3 × mq-15 CONNECT-UP: construct the sole production `ProofSubstrate`
  // (`PgProofSubstrate`) over the shared pool + secret store, over a SINGLE shared
  // `PgCasByteStore` (so the substrate's own proof/bundle bytes and the watcher's
  // sealed-artifact bytes land in the same CAS). This is the REAL substrate the
  // merge-train artifact watcher (below) and future gate-proof consumers seal/verify
  // with — no external injection, no dormant optional. Probe the signing key ONCE so
  // the operator sees an observable line: sealing is LIVE, or PENDING key provisioning
  // (still constructed + wired — any seal/verify then fails LOUD, never a silent no-op).
  const casByteStore: CasByteStore = new PgCasByteStore(deps.pool);
  const proofSubstrate = new PgProofSubstrate(deps.pool, deps.secrets, { casByteStore });
  try {
    const signingKey = await resolveSigningKey(deps.secrets, PROOF_SIGNING_KEY_REF);
    log.info("proof substrate constructed; ed25519 signing key resolved — bundle sealing is LIVE", {
      signingKeyId: signingKey.signingKeyId,
      signingKeyRef: PROOF_SIGNING_KEY_REF,
    });
  } catch (error) {
    // Observable, LOUD dormancy — NOT a silent "no substrate". The substrate is still
    // constructed and injected into the watcher; any seal/verify fails loud with the
    // same typed error until the platform signing key is provisioned.
    log.error("proof substrate constructed but signing key is NOT provisioned — seal/verify will fail loud", {
      signingKeyRef: PROOF_SIGNING_KEY_REF,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  // mq-15 merge-train artifact watcher: a sealed-delivery PROJECTION driven AFTER the
  // delivery DAG driver (in-17). It invents NO signer — sealing/verification are DELEGATED
  // to the sole production `PgProofSubstrate` constructed just above (its seal path is now
  // LIVE, not dormant). Once the delivery DAG has driven deploy → verify → demo to durable
  // completion for a land group, this seals that completed land group into a signed
  // delivery artifact; missing the signing key fails LOUD at seal time (fail-closed), never
  // silently no-ops.
  const mergeTrainArtifactWatcher = buildMergeTrainArtifactWatcher({
    pool: deps.pool,
    proofSubstrate,
    casByteStore,
  });
  // ds-6 design-delivery coordinator (production phase): a `RunMergeWatcher` driven LAST in
  // the post-merge chain (after the delivery DAG + merge-train watcher). It links the LIVE
  // production artifact/deploy + proof-backed behavior verdict to the pre-merge design matrix
  // (A4 ≡ demo) ONLY on an exact artifact + scenario-set match; a blocked join records nothing.
  const designDeliveryCoordinator = buildDesignAwareDeliveryCoordinator(deps.pool, deps.runStateWriter);
  // mq-13 GROUP-level delivery loop: driven FIRST in the post-merge chain. For a completed land
  // group's tail run it deploys/previews/verifies/demos/promotes the WHOLE group ONCE (emitting
  // the group's `deploy.verified` / `demo.completed` so mq-15 seals + ds-6 joins from the group's
  // evidence), then rolls back / routes repair on a production regression. Group members' per-run
  // in-17 delivery is membership-guarded off, so a group deploys ONCE, not once per member.
  const landGroupDeliveryLoop = buildLandGroupDeliveryLoop({
    pool: deps.pool,
    secrets: deps.secrets,
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
  });
  const postMerge = await startPostMergeSubscriber({
    pool: deps.pool,
    notifyListener: postMergeNotifyListener,
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    landGroupDeliveryLoop,
    deliveryDriver,
    mergeTrainArtifactWatcher,
    designDeliveryCoordinator,
    ...(deps.githubAppMinter !== undefined && { githubAppMinter: deps.githubAppMinter }),
    // Plane-split: the watcher's post-merge events route through the control plane
    // when wired (else direct on deps.pool, byte-identical).
    runStateWriter: deps.runStateWriter,
  });
  log.info("post-merge auto-issue + durable delivery-DAG subscriber started (in-17)");
  // Notifications: build the dispatcher ONCE (channel registry with the real
  // channel deps — `secrets` resolves Slack/webhook/etc. write-only credential
  // refs; the shared App minter authenticates github_checks) + the code-level default
  // route, then start the subscriber. It wakes on the `tanren_notify` bus — fired
  // at the event-append seam for EVERY event — and fans each event through the
  // dispatcher's matrix + severity filter. This is what makes escalations real:
  // `dag.spec.needs_attention` (project-scoped, no run id ⇒ no `tanren_run` wake)
  // reaches a human only because notifications key off the every-event channel.
  // Its own LISTEN connection so it never contends with the other notify pumps.
  const { listener: notificationNotifyListener, subscriber: notifications } = await startWorkerNotifications({
    pool: deps.pool,
    secrets: deps.secrets,
    ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
  });
  log.info("notification dispatcher subscriber started (events now reach humans)");
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
    runStateWriter: deps.runStateWriter,
  });
  log.info("intake poller + audit scheduler loops started (autonomy-engine §1d)");
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
    runStateWriter: deps.runStateWriter,
  });
  log.info("CI-insights detect+quarantine + generative root-cause loop started (CI-intelligence PR2+PR3)");
  // task #82: the window-pause auto-resume prober — a sign-of-life loop that
  // finds runs in the NEW non-terminal `paused` status (a `window_exhausted`
  // writer/answerer outcome routed them there via the `pause_for_capacity`
  // bucket) and resumes them so the walker re-enqueues a successor run. Not a
  // wall-clock waiter; the doctrine extension of timeout-eradication to
  // provider usage windows. Probes every `DEFAULT_PROBE_INTERVAL_MS` (60s by
  // default) — HOW OFTEN to ask "did capacity return", never a deadline.
  const pausedRunResumeProber = startPausedRunResumeProber({
    pool: deps.pool,
    runStateWriter: deps.runStateWriter,
  });
  log.info("paused-run resume prober started (task #82 — window-pause auto-resume)");
  const stop = async (): Promise<void> => {
    // Codex RA1 (Bug 2 stop() race): the four notify subscribers' `stop()` now
    // returns a promise that drains the underlying `subscribeWithReconnect`
    // loop (any in-flight `PgNotifyListener.subscribe(…)` resolves/throws
    // BEFORE the promise settles) — await them so a subsequent restart or
    // teardown never races a still-in-flight subscribe from the prior lifetime.
    resolutionDagWalker.stop();
    sourceSyncWorker.stop();
    await Promise.all([dagWalker.stop(), mergeCoordinator.stop(), postMerge.stop(), notifications.stop()]);
    intake.stop();
    ciInsights.stop();
    pausedRunResumeProber.stop();
    await dagNotifyListener.close();
    await mergeNotifyListener.close();
    await postMergeNotifyListener.close();
    await notificationNotifyListener.close();
  };
  return {
    dagWalker,
    resolutionDagWalker,
    sourceSyncWorker,
    mergeCoordinator,
    postMerge,
    notifications,
    intake,
    ciInsights,
    pausedRunResumeProber,
    proofSubstrate,
    stop,
  };
}
