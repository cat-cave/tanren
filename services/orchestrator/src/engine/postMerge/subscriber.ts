// The PostMergeWatcher subscriber (tempering.md dimension A, autonomy-engine §1.5):
// a long-lived per-process listener that drives the PostMergeWatcher on every
// run-activity notification — reacting to the events ALREADY on the LISTEN/NOTIFY
// bus (the SAME `tanren_run` channel the DagWalker / MergeCoordinator use), no new
// poller. It is the wiring the worker boot starts so post-merge-failure tracking
// self-drives.
//
// Mechanism mirrors the DagWalker / MergeCoordinator subscribers: the eventStore
// fires a `tanren_run` NOTIFY (payload = the run id) at every run-state change —
// including `merge.completed` (the merge finalizes the run + fires a notify). This
// subscriber wakes on that channel and hands the run id to the watcher, which is a
// no-op unless the run merged + the post-merge CI on the base branch failed.
//
// Coalesced PER RUN (the post-merge check is per-run, keyed on the run's
// merge.completed): a run already being checked re-checks once when its current
// pass finishes, so a notification storm collapses to at most one in-flight check +
// one queued re-check. The watcher's own `issue.opened` idempotency guard is the
// hard "one issue per merge" boundary regardless; coalescing keeps the load sane.

import { RUN_ACTIVITY_CHANNEL, type PgNotifyListener } from "@tanren/db";
import { PostMergeWatcher, type PostMergeWatcherDeps } from "./watcher.js";
import { createLogger } from "../observability/logger.js";
import { subscribeWithReconnect, type SubscribeWithReconnectHandle } from "../db/notifySubscriber.js";
// The post-merge deploy/demo/merge-train watcher builders are direct collaborators of
// this subscriber (they run inside its chain); re-exported here so the autonomy-loop
// composition root imports the whole post-merge builder set — including mq-15's
// merge-train artifact watcher + its CAS byte-store type — from one module (the
// runtime-import cap).
export {
  buildDeployOnMergeWatcher,
  buildDemoOnDeployWatcher,
  buildDeliveryDagDriver,
  buildMergeTrainArtifactWatcher,
  type CasByteStore,
} from "./deployOnMerge.js";

const log = createLogger("post-merge");

/** The minimal per-run watcher shape the subscriber drives on each bus wake. */
export interface RunMergeWatcher {
  check(runId: string): Promise<void>;
}

export interface PostMergeSubscriberDeps extends PostMergeWatcherDeps {
  /** The shared LISTEN connection (its own, so it never contends with the walker's pump). */
  notifyListener: PgNotifyListener;
  /**
   * The watcher to drive. Defaults to the production `PostMergeWatcher`. A test
   * injects a recording watcher to assert the event-driven trigger fires it.
   */
  watcher?: PostMergeWatcher;
  /**
   * The durable, resumable post-merge DELIVERY DAG driver (in-17). REPLACES the old fixed
   * deploy → demo chain: driven on the SAME `merge.completed` wake as the issue watcher, it
   * consumes the in-16 `delivery_runs` transactional outbox and drives reconcile → lease →
   * materialize → attach → deploy → verify → stimulate → observe → record-evidence,
   * resuming from the last durable stage and marking the delivery complete ONLY after
   * signed evidence of the independently-observed effect. The deploy-on-merge and
   * demo-on-deploy watchers are now this driver's INTERNAL stage runners, not a separate
   * fixed chain. Optional — wired when a deploy transport is available; absent, the
   * subscriber only drives the issue watcher. ISOLATED — a delivery failure is logged +
   * durably recorded, never suppressing the issue watcher.
   */
  deliveryDriver?: RunMergeWatcher;
  /**
   * The mq-15 merge-train artifact watcher (a sealed delivery PROJECTION): driven on the
   * SAME wake, AFTER the delivery DAG driver (in-17), so by the time it runs the deploy +
   * demo evidence the delivery DAG's internal stage runners emit (`deploy.verified` /
   * `demo.completed`) is already durable for a completed delivery. It seals ONE artifact
   * per completed land group only when every bound input is exact, and is a clean no-op
   * otherwise (including while a delivery is still degraded/in-flight and its evidence is
   * not yet durable). ISOLATED — a seal failure is logged and never suppresses the others.
   * Optional: wired only when a `ProofSubstrate` is available to inject (no signer of its
   * own).
   */
  mergeTrainArtifactWatcher?: RunMergeWatcher;
}

/**
 * The running subscriber handle: on every run-activity notification it drives the
 * watcher for that run. `stop()` unsubscribes (idempotent). Per-run checks are
 * coalesced so a storm of notifications collapses into at most one in-flight check
 * + one queued re-check per run.
 */
export class PostMergeSubscriber {
  private readonly watcher: PostMergeWatcher;
  private readonly deliveryDriver: RunMergeWatcher | undefined;
  private readonly mergeTrainArtifactWatcher: RunMergeWatcher | undefined;
  private reconnectHandle: SubscribeWithReconnectHandle | undefined;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rePending = new Set<string>();

  constructor(private readonly deps: PostMergeSubscriberDeps) {
    this.watcher = deps.watcher ?? new PostMergeWatcher(deps);
    this.deliveryDriver = deps.deliveryDriver;
    this.mergeTrainArtifactWatcher = deps.mergeTrainArtifactWatcher;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    this.subscribeToNotifyBus();
  }

  /**
   * Subscribe to the run-activity bus via the shared `subscribeWithReconnect`
   * helper (audit C2 #4-#7): the helper drives an UNBOUNDED progress-spaced
   * retry on both the initial subscribe AND on a live connection drop, so a
   * boot-time PG blip no longer silently degrades the post-merge deploy watcher
   * to permanent silence — merged runs otherwise stayed
   * `triggered-but-unverified` for the whole process lifetime.
   */
  private subscribeToNotifyBus(): void {
    const handle = subscribeWithReconnect({
      listener: this.deps.notifyListener,
      channel: RUN_ACTIVITY_CHANNEL,
      logger: log,
      handler: (payload) => {
        void this.onRunActivity(payload).catch((error: unknown) => {
          log.error("run-activity handler failed", { runId: payload }, error);
        });
      },
    });
    if (this.stopped) {
      // stop() raced the wiring: drain the helper in the background — the
      // outer `stop()` promise is the authoritative drain. Fire-and-forget is
      // safe (helper stop is idempotent + cached).
      void handle.stop();
      return;
    }
    this.reconnectHandle = handle;
  }

  /**
   * Stop listening. Idempotent; in-flight checks finish on their own. Returns
   * a promise that resolves AFTER the reconnect helper's own drain settles
   * (it waits for the in-flight `PgNotifyListener.subscribe(…)` to
   * resolve/throw), so a `await stop(); await start();` sequence never leaves
   * two live handler sets on the shared listener for a tick (Codex RA1).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const drain = this.reconnectHandle?.stop();
    this.reconnectHandle = undefined;
    if (drain !== undefined) await drain;
  }

  private async onRunActivity(runId: string): Promise<void> {
    if (runId === "") return;
    await this.schedule(runId);
  }

  /** Check a run, coalescing concurrent requests (latest state, once). */
  private schedule(runId: string): Promise<void> {
    const existing = this.inFlight.get(runId);
    if (existing !== undefined) {
      this.rePending.add(runId);
      return existing;
    }
    const run = this.runChain(runId).finally(() => {
      this.inFlight.delete(runId);
    });
    this.inFlight.set(runId, run);
    return run;
  }

  /** Check, then re-check while a trigger arrived mid-pass. */
  private async runChain(runId: string): Promise<void> {
    do {
      this.rePending.delete(runId);
      await this.watcher.check(runId).catch((error: unknown) => {
        log.error("check failed", { runId }, error);
      });
      // The durable delivery DAG driver (in-17) runs on the SAME wake but is ISOLATED: it
      // consumes the in-16 delivery outbox and drives reconcile → lease → materialize →
      // attach → deploy → verify → stimulate → observe → record-evidence, resuming from the
      // last durable stage. Its own failures are recorded durably on `delivery_runs` /
      // `delivery_stage_attempts`; a thrown driver error is logged and never suppresses the
      // issue watcher. This REPLACES the old fixed deploy → demo chain (the deploy/demo
      // watchers are now the driver's internal, idempotent stage runners).
      if (this.deliveryDriver !== undefined) {
        await this.deliveryDriver.check(runId).catch((error: unknown) => {
          log.error("delivery-dag failed", { runId }, error);
        });
      }
      // The mq-15 merge-train artifact watcher runs AFTER the delivery DAG driver (so the
      // deploy + demo evidence the delivery DAG's internal stage runners durably emit is
      // present for a completed delivery) and is equally ISOLATED: a seal failure is logged
      // and never suppresses the issue/delivery watchers. A run that is not a completed
      // land-group tail — or a delivery still degraded/in-flight — is a clean no-op.
      if (this.mergeTrainArtifactWatcher !== undefined) {
        await this.mergeTrainArtifactWatcher.check(runId).catch((error: unknown) => {
          log.error("merge-train-artifact failed", { runId }, error);
        });
      }
    } while (this.rePending.has(runId));
  }
}

/** Build + start the PostMergeWatcher subscriber from the worker boot. */
export async function startPostMergeSubscriber(deps: PostMergeSubscriberDeps): Promise<PostMergeSubscriber> {
  const subscriber = new PostMergeSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
