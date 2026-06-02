// The DagWalker subscriber (autonomy-engine.md §1a, §1.5): a long-lived
// per-process listener that drives the per-project DagWalker on startup and on
// every run.*-terminal / merge.completed notification — reacting to the
// run-activity events ALREADY on the LISTEN/NOTIFY bus, no new polling. It is the
// wiring the worker boot starts so the DAG self-drives.
//
// Mechanism: the eventStore fires a `tanren_run` NOTIFY (payload = the run id) at
// every run-state change. This subscriber wakes on that channel, resolves the
// run's project + status under the system scope (the payload carries no tenant
// data, so it must re-read), and — when the run reached a TERMINAL state (a spec
// finished, freeing a slot / unblocking dependents) — walks that run's project.
// Walks are COALESCED per project: a project already walking re-walks once when
// its current walk finishes (so a notification storm collapses to at most one
// follow-up walk), and two terminal runs for the same project never race a
// double-enqueue (the pending→active claim inside createQueuedRunFromSpec is the
// idempotency boundary regardless, but coalescing keeps the load sane).
//
// Reaching `merge.completed` is a strict subset of "run reached terminal" here
// (a merge finalizes the run + flips the spec to merged), so keying off terminal
// run status covers both triggers in Phase 1 without parsing event types off the
// payload-free channel.

import { RUN_ACTIVITY_CHANNEL, type PgNotifyListener, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { DagWalker } from "../contracts/dagWalker.js";
import type { SpeculativeIntegrator } from "../contracts/speculativeIntegrator.js";
import { isTerminalStatus } from "../benchmark/runnerDb.js";
import { buildDagWalker, listWalkableProjectIds } from "./walker.js";

export interface DagWalkerSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (the SAME one the SSE source / benchmark use). */
  notifyListener: PgNotifyListener;
  /**
   * The speculative integrator (P2c-1) the production walker uses to build a
   * dependent's dynamic-base integration branch. Required when `walker` is not
   * injected (the production path); a test that injects `walker` omits it.
   */
  integrator?: SpeculativeIntegrator;
  /**
   * The walker to drive. Defaults to the production `buildDagWalker(pool,
   * { integrator })`. A test injects a recording walker to assert the event-driven
   * trigger fires it (then `integrator` is not needed).
   */
  walker?: DagWalker;
}

/**
 * Resolve a run's project id + whether it is in a terminal state, system-scoped
 * (the `tanren_run` payload is only the run id — RLS would deny a tenant-scoped
 * read with no org context, so this MUST run cross-org like the worker's bootstrap
 * of a claimed job's org). Returns undefined when the run is not yet visible.
 */
async function resolveRunTrigger(
  pool: pg.Pool,
  runId: string,
): Promise<{ projectId: string; terminal: boolean } | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ project_id: string | null; status: string }>(
      "SELECT project_id, status FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined || row.project_id === null) return;
    return { projectId: row.project_id, terminal: isTerminalStatus(row.status) };
  });
}

/**
 * The running subscriber handle: walks every project once on start, then walks a
 * project whenever one of its runs reaches terminal. `stop()` unsubscribes from
 * the bus (idempotent). Per-project walks are coalesced so a storm of terminal
 * notifications collapses into at most one in-flight walk + one queued re-walk.
 */
export class DagWalkerSubscriber {
  private readonly walker: DagWalker;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  // Per-project walk coalescing: the in-flight walk promise + a "re-walk when it
  // finishes" flag, so concurrent triggers never run two walks of one project at
  // once and never drop a trigger that arrived mid-walk.
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly reWalkPending = new Set<string>();

  constructor(private readonly deps: DagWalkerSubscriberDeps) {
    this.walker = deps.walker ?? this.buildProductionWalker();
  }

  /** Build the production walker; requires the integrator (no walker injected). */
  private buildProductionWalker(): DagWalker {
    const integrator = this.deps.integrator;
    if (integrator === undefined) {
      throw new Error("DagWalkerSubscriber requires a SpeculativeIntegrator when no walker is injected");
    }
    return buildDagWalker(this.deps.pool, { integrator });
  }

  /**
   * Subscribe to the run-activity bus and kick off the initial drive of every
   * project — both NON-BLOCKING. The worker boot builds a lazy pool that may not
   * be reachable yet (it connects on first claim), so `start()` must not block on
   * the network: the LISTEN subscribe and the initial drive run in the background.
   * A subscribe/read failure is logged, never fatal (the PgNotifyListener
   * reconnects on its own and the next notification re-drives). `start()` resolves
   * immediately so the boot returns; `stop()` tears down whatever was wired.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    void this.subscribeInBackground();
    void this.driveAllProjects();
  }

  /** Subscribe to the bus off the boot path; tolerant of a not-yet-ready DB. */
  private async subscribeInBackground(): Promise<void> {
    try {
      const unsubscribe = await this.deps.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
        // Fire-and-forget: the wake handler must not block the LISTEN connection.
        // A resolve/walk failure is logged, never thrown into the notify pump.
        void this.onRunActivity(payload).catch((error: unknown) => {
          console.error(`[dag-walker] run-activity handler failed for run ${payload}:`, error);
        });
      });
      // If stop() raced ahead of the connect, unsubscribe immediately.
      if (this.stopped) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
    } catch (error) {
      console.error("[dag-walker] failed to subscribe to the run-activity bus (will not auto-drive):", error);
    }
  }

  /** Best-effort initial walk of every project with a DAG. */
  private async driveAllProjects(): Promise<void> {
    try {
      const projectIds = await listWalkableProjectIds(this.deps.pool);
      await Promise.all(projectIds.map((projectId) => this.scheduleWalk(projectId)));
    } catch (error) {
      console.error("[dag-walker] initial project drive failed (will drive on the next notification):", error);
    }
  }

  /** Stop listening. Idempotent; in-flight walks finish on their own. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Handle one `tanren_run` wake: walk the run's project only when it terminated. */
  private async onRunActivity(runId: string): Promise<void> {
    if (runId === "") return;
    const trigger = await resolveRunTrigger(this.deps.pool, runId);
    if (trigger === undefined || !trigger.terminal) return;
    await this.scheduleWalk(trigger.projectId);
  }

  /**
   * Walk a project, coalescing concurrent requests: if a walk is already in
   * flight for this project, mark a re-walk and return — the in-flight walk runs
   * the re-walk when it completes, so the LATEST DAG state is always re-evaluated
   * exactly once after the last trigger, never concurrently.
   */
  private scheduleWalk(projectId: string): Promise<void> {
    const existing = this.inFlight.get(projectId);
    if (existing !== undefined) {
      this.reWalkPending.add(projectId);
      return existing;
    }
    const run = this.runWalkChain(projectId).finally(() => {
      this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, run);
    return run;
  }

  /** Walk, then re-walk while a trigger arrived mid-walk (drains the coalesce flag). */
  private async runWalkChain(projectId: string): Promise<void> {
    do {
      this.reWalkPending.delete(projectId);
      await this.walker.walk(projectId);
    } while (this.reWalkPending.has(projectId));
  }
}

/**
 * Build + start the DagWalker subscriber from the worker boot. Returns the handle
 * so the boot's `stop()` can tear it down with the worker + reaper.
 */
export async function startDagWalkerSubscriber(deps: DagWalkerSubscriberDeps): Promise<DagWalkerSubscriber> {
  const subscriber = new DagWalkerSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
