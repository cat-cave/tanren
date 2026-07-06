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
   * The deploy-on-merge watcher (apex "a deploy happened"): driven on the SAME
   * `merge.completed` wake as the issue watcher. Optional — wired when a deploy
   * transport is available; absent, the subscriber only drives the issue watcher. A
   * deploy failure is logged + isolated, so it never suppresses the issue watcher.
   */
  deployWatcher?: RunMergeWatcher;
  /**
   * The demo-on-deploy watcher (demos-as-evidence): driven on the SAME wake, AFTER the
   * deploy watcher, so by the time it runs the deploy watcher has emitted
   * `deploy.verified`. It exercises the spec's behaviors against the verified deploy
   * surface and records per-behavior evidence; a run with no verified deploy is a
   * clean no-op. ISOLATED — a demo failure is logged and never suppresses the others.
   */
  demoWatcher?: RunMergeWatcher;
}

/**
 * The running subscriber handle: on every run-activity notification it drives the
 * watcher for that run. `stop()` unsubscribes (idempotent). Per-run checks are
 * coalesced so a storm of notifications collapses into at most one in-flight check
 * + one queued re-check per run.
 */
export class PostMergeSubscriber {
  private readonly watcher: PostMergeWatcher;
  private readonly deployWatcher: RunMergeWatcher | undefined;
  private readonly demoWatcher: RunMergeWatcher | undefined;
  private reconnectHandle: SubscribeWithReconnectHandle | undefined;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rePending = new Set<string>();

  constructor(private readonly deps: PostMergeSubscriberDeps) {
    this.watcher = deps.watcher ?? new PostMergeWatcher(deps);
    this.deployWatcher = deps.deployWatcher;
    this.demoWatcher = deps.demoWatcher;
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
      // The deploy-on-merge watcher runs on the SAME wake but is ISOLATED: a deploy
      // failure is logged and never suppresses the issue watcher (and vice versa).
      if (this.deployWatcher !== undefined) {
        await this.deployWatcher.check(runId).catch((error: unknown) => {
          log.error("deploy-on-merge failed", { runId }, error);
        });
      }
      // The demo-on-deploy watcher runs AFTER the deploy watcher (so `deploy.verified`
      // is already emitted) but is equally ISOLATED: a demo failure is logged and never
      // suppresses the issue/deploy watchers. A run with no verified deploy is a no-op.
      if (this.demoWatcher !== undefined) {
        await this.demoWatcher.check(runId).catch((error: unknown) => {
          log.error("demo-on-deploy failed", { runId }, error);
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
