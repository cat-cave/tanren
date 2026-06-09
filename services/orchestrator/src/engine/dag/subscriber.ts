// The DagWalker subscriber (autonomy-engine.md §1a, §1.5): a long-lived
// per-process listener that drives the per-project DagWalker on startup, on
// every run.*-terminal / merge.completed notification, AND on every DAG-change
// (spec-creation) notification — reacting to events ALREADY on the LISTEN/NOTIFY
// bus, no new polling. It is the wiring the worker boot starts so the DAG
// self-drives.
//
// Two wake sources:
//   - `tanren_run` (payload = run id): the eventStore fires it at every run-state
//     change. The subscriber resolves the run's project + status under the system
//     scope (the payload carries no tenant data, so it must re-read), and — when
//     the run reached a TERMINAL state (a spec finished, freeing a slot /
//     unblocking dependents) — walks that run's project.
//   - `tanren_dag` (payload = project id): fired at the spec INSERT seam
//     (`createSpec`). A freshly-derived/created project has pending specs but ZERO
//     runs, so the run-activity channel never fires for it — without this channel
//     its first walk would only happen on the next worker reboot. The subscriber
//     walks the carried project directly (the payload IS the project id, so no
//     re-resolve is needed; the walk itself reads the DAG system-scoped).
//
// Walks are COALESCED per project across BOTH channels: a project already walking
// re-walks once when its current walk finishes (so a notification storm — terminal
// runs and/or a burst of spec inserts during derive — collapses to at most one
// follow-up walk), and concurrent triggers for the same project never race a
// double-enqueue (the pending→active claim inside createQueuedRunFromSpec is the
// idempotency boundary regardless, but coalescing keeps the load sane).
//
// Reaching `merge.completed` is a strict subset of "run reached terminal" here
// (a merge finalizes the run + flips the spec to merged), so keying off terminal
// run status covers both triggers without parsing event types off the
// payload-free channel.

import { DAG_CHANGE_CHANNEL, RUN_ACTIVITY_CHANNEL, type PgNotifyListener, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { DagWalker } from "../contracts/dagWalker.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SpeculativeIntegrator } from "../contracts/speculativeIntegrator.js";
import { isTerminalStatus } from "../benchmark/runnerDb.js";
import type { ChangePercolationCoordinator } from "./percolation.js";
import { buildDagWalker, listWalkableProjectIds } from "./walker.js";

/**
 * The default periodic re-walk backstop cadence (audit §3.13a): slow on purpose —
 * the bus is the PRIMARY driver, this only catches a lost NOTIFY / a resumed budget.
 */
const DEFAULT_RE_WALK_INTERVAL_MS = 60_000;

export interface DagWalkerSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (the SAME one the SSE source / benchmark use). */
  notifyListener: PgNotifyListener;
  /**
   * The speculative integrator the production walker uses to build a
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
  /**
   * change-percolation: the coordinator that, on the SAME notifications,
   * detects whether an ancestor changed under an in-flight speculative dependent
   * and percolates the delta down the chain (NOT discard). Optional — when absent
   * the subscriber only walks (a test that asserts walking alone omits it); the
   * worker boot always supplies it so percolation is live. It runs AFTER the walk
   * so a freshly-enqueued dependent's SHAs are already recorded before detection.
   */
  percolation?: ChangePercolationCoordinator;
  /**
   * PERIODIC RE-WALK BACKSTOP (audit §3.13a): how often to re-walk EVERY walkable
   * project regardless of notifications. The DagWalker is otherwise driven PURELY by
   * the LISTEN/NOTIFY bus — but a NOTIFY lost in the listener's reconnect gap
   * (`db/notify.ts` re-LISTEN window) would de-animate the DAG until the next worker
   * reboot, AND a project paused on budget has NO notification that re-animates it when
   * its ceiling is later raised. This backstop tick re-walks all projects on a slow
   * cadence so a lost wake (or a resumed budget) self-heals within one interval.
   * Defaults to 60s; a test injects a small value (and its own `setInterval` seam).
   */
  reWalkIntervalMs?: number;
  /**
   * Test seam for the periodic backstop's timer. Defaults to the global
   * `setInterval`/`clearInterval`; a test injects a controllable pair so the tick is
   * deterministic. The handle type is opaque (the matching `clear` consumes it).
   */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the production walker routes its run-CREATION
   * (createQueuedRunFromSpec) AND its dag.* event emissions through the control
   * plane instead of writing `runs`/`specs`/`tasks`/`events` directly on the
   * de-privileged pool. Absent (single-role dev), the walker writes directly —
   * byte-identical to today. Only consulted when `walker` is not injected (a test
   * that injects a recording walker omits it).
   */
  runStateWriter?: RunStateWriter;
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
  private readonly unsubscribes: Array<() => void> = [];
  private stopped = false;
  // Per-project walk coalescing: the in-flight walk promise + a "re-walk when it
  // finishes" flag, so concurrent triggers never run two walks of one project at
  // once and never drop a trigger that arrived mid-walk.
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly reWalkPending = new Set<string>();
  // The periodic-backstop timer handle (audit §3.13a); undefined until start().
  private reWalkTimer: unknown;
  private readonly reWalkIntervalMs: number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly deps: DagWalkerSubscriberDeps) {
    this.walker = deps.walker ?? this.buildProductionWalker();
    this.reWalkIntervalMs = deps.reWalkIntervalMs ?? DEFAULT_RE_WALK_INTERVAL_MS;
    this.setIntervalFn = deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn =
      deps.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** Build the production walker; requires the integrator (no walker injected). */
  private buildProductionWalker(): DagWalker {
    const integrator = this.deps.integrator;
    if (integrator === undefined) {
      throw new Error("DagWalkerSubscriber requires a SpeculativeIntegrator when no walker is injected");
    }
    return buildDagWalker(this.deps.pool, {
      integrator,
      // Plane-split: route the walker's run-creation + dag.* events through the
      // control plane when a writer is wired; else direct on the pool.
      ...(this.deps.runStateWriter !== undefined && { runStateWriter: this.deps.runStateWriter }),
    });
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
    this.startPeriodicBackstop();
  }

  /**
   * Arm the PERIODIC RE-WALK BACKSTOP (audit §3.13a): every `reWalkIntervalMs`, re-walk
   * every walkable project so a NOTIFY lost in the listener's reconnect gap (or a
   * project paused on budget whose ceiling was later raised — §3.7e) self-heals within
   * one interval rather than staying de-animated until a worker reboot. Walks route
   * through the SAME per-project coalescing guard, so the tick never double-enqueues
   * and a still-running walk just marks a re-walk. A pass failure is logged, never
   * fatal — the next tick retries. Idempotent: re-arming is a no-op while a timer holds.
   */
  private startPeriodicBackstop(): void {
    if (this.stopped || this.reWalkTimer !== undefined || this.reWalkIntervalMs <= 0) return;
    this.reWalkTimer = this.setIntervalFn(() => {
      void this.driveAllProjects();
    }, this.reWalkIntervalMs);
  }

  /** Subscribe to both wake channels off the boot path; tolerant of a not-yet-ready DB. */
  private async subscribeInBackground(): Promise<void> {
    try {
      const runUnsub = await this.deps.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
        // Fire-and-forget: the wake handler must not block the LISTEN connection.
        // A resolve/walk failure is logged, never thrown into the notify pump.
        void this.onRunActivity(payload).catch((error: unknown) => {
          console.error(`[dag-walker] run-activity handler failed for run ${payload}:`, error);
        });
      });
      this.track(runUnsub);

      const dagUnsub = await this.deps.notifyListener.subscribe(DAG_CHANGE_CHANNEL, (payload) => {
        // A spec was inserted for this project: walk it now (the payload IS the
        // project id). Coalesced through the same per-project in-flight guard, so
        // a burst of inserts during derive collapses to one follow-up walk.
        void this.onDagChange(payload).catch((error: unknown) => {
          console.error(`[dag-walker] dag-change handler failed for project ${payload}:`, error);
        });
      });
      this.track(dagUnsub);
    } catch (error) {
      console.error("[dag-walker] failed to subscribe to the LISTEN/NOTIFY bus (will not auto-drive):", error);
    }
  }

  /** Record an unsubscribe — or, if stop() raced the connect, fire it immediately. */
  private track(unsubscribe: () => void): void {
    if (this.stopped) {
      unsubscribe();
      return;
    }
    this.unsubscribes.push(unsubscribe);
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
    if (this.reWalkTimer !== undefined) {
      this.clearIntervalFn(this.reWalkTimer);
      this.reWalkTimer = undefined;
    }
    while (this.unsubscribes.length > 0) {
      this.unsubscribes.pop()?.();
    }
  }

  /** Handle one `tanren_run` wake: walk the run's project only when it terminated. */
  private async onRunActivity(runId: string): Promise<void> {
    if (runId === "") return;
    const trigger = await resolveRunTrigger(this.deps.pool, runId);
    if (trigger === undefined || !trigger.terminal) return;
    await this.scheduleWalk(trigger.projectId);
  }

  /**
   * Handle one `tanren_dag` wake: a spec was inserted for this project, so its
   * DAG may have a newly-ready spec. The payload IS the project id (no run to
   * resolve), so walk it directly through the coalescing guard.
   */
  private async onDagChange(projectId: string): Promise<void> {
    if (projectId === "") return;
    await this.scheduleWalk(projectId);
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

  /**
   * Walk, then re-walk while a trigger arrived mid-walk (drains the coalesce flag).
   *
   * DRAIN-ON-THROW (audit §3.13d): the coalesce flag is cleared at the TOP of each
   * iteration and the whole body is guarded so a `walk()`/`percolate()` throw can never
   * strand a recorded-but-never-drained re-walk. A trigger that arrives mid-walk sets
   * `reWalkPending`; the `do/while` re-checks it after the body, so even a throwing
   * iteration loops once more to honor the queued trigger before exiting. Without the
   * guard a single walk throw would `.finally`-delete the in-flight entry and abandon a
   * pending re-walk until the next external notification (a microtask-race de-animation).
   */
  private async runWalkChain(projectId: string): Promise<void> {
    do {
      this.reWalkPending.delete(projectId);
      try {
        const result = await this.walker.walk(projectId);
        // BUDGET-PAUSED CHAIN STOP (audit §3.13e): when the walk paused on budget it
        // enqueued NOTHING — so the change-percolation / base-shift chain must NOT run.
        // Percolation allocates runners + spends (a live jj rebase + re-gate over a
        // real runner), which would keep burning money PAST the ceiling the walk just
        // honored. Skip it on a budget pause; the periodic backstop (§3.13a) re-walks
        // and resumes percolation once the ceiling is raised / the window rolls.
        if (result.status === "budget_paused") {
          console.warn(
            `[dag-walker] project ${projectId} paused on budget — skipping change-percolation (no runner spend past the ceiling)`,
          );
          continue;
        }
        // walk → baseShift (tanren-owns-the-engine.md §3/§7): after the walk (so any
        // just-enqueued speculative dependent's integrated SHAs are already recorded),
        // the change-percolation coordinator detects ancestor changes under in-flight
        // dependents and routes each through the ONE base-shift handler
        // (`BaseShiftCoordinator.rebaseOnto`) — a never-discard REBASE of the dependent's
        // existing run/branch in place, NOT the deleted supersede+regenerate. A failure
        // is logged, never fatal to the walk loop — the next notification re-detects.
        if (this.deps.percolation !== undefined) {
          await this.deps.percolation.percolate(projectId).catch((error: unknown) => {
            console.error(`[dag-walker] change-percolation pass failed for project ${projectId}:`, error);
          });
        }
      } catch (error) {
        // A walk/percolate throw must not abandon a queued re-walk: log it and let the
        // `do/while` re-check `reWalkPending` so a mid-walk trigger still drains.
        console.error(`[dag-walker] walk chain iteration failed for project ${projectId}:`, error);
      }
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
