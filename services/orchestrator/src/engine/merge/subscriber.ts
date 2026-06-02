// The MergeCoordinator subscriber (autonomy-engine.md §2d, §1.5): a long-lived
// per-process listener that drives the per-project MergeCoordinator on startup and
// on every run.*-terminal / merge.completed notification — reacting to the events
// ALREADY on the LISTEN/NOTIFY bus, no new polling. It is the wiring the worker
// boot starts so the native merge queue self-advances.
//
// Mechanism mirrors the DagWalkerSubscriber: the eventStore fires a `tanren_run`
// NOTIFY (payload = the run id) at every run-state change. This subscriber wakes on
// that channel, resolves the run's project under the system scope, and coordinates
// that project's queue. Each pass merges AT MOST ONE entry (serialization); a merge
// completing fires another `tanren_run` notification (the merge finalizes the run),
// which re-triggers the coordinator to pick the NEXT DAG-ordered head — so A merges,
// then B, then C in dependency order, one at a time.
//
// Coalesced per project (like the walker): a project already coordinating
// re-coordinates once when its current pass finishes, so a notification storm
// collapses to at most one follow-up pass. The atomic queue claim is the hard
// serialization boundary regardless; coalescing keeps the load sane.

import { RUN_ACTIVITY_CHANNEL, type PgNotifyListener, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { MergeCoordinator } from "../contracts/mergeCoordinator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildBatchMergeCoordinator } from "./batchCoordinatorBuild.js";

export interface MergeCoordinatorSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (the SAME one the SSE source / walker use). */
  notifyListener: PgNotifyListener;
  /** Required when `coordinator` is not injected (the production path). */
  secrets?: SecretStore;
  vcsProvider?: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The coordinator to drive. Defaults to the production
   * `buildMergeCoordinator(...)`. A test injects a recording coordinator to assert
   * the event-driven trigger fires it.
   */
  coordinator?: MergeCoordinator;
}

/** Resolve a run's project id, system-scoped (the `tanren_run` payload is run-only). */
async function resolveRunProject(pool: pg.Pool, runId: string): Promise<string | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ project_id: string | null }>("SELECT project_id FROM runs WHERE run_id = $1", [
      runId,
    ]);
    return result.rows[0]?.project_id ?? undefined;
  });
}

/** Discover every project that has a native merge queue to coordinate (system-scoped). */
async function listProjectsWithQueue(pool: pg.Pool): Promise<string[]> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ project_id: string }>(
      "SELECT DISTINCT project_id FROM merge_queue WHERE status IN ('queued', 'merging') ORDER BY project_id",
    );
    return result.rows.map((row) => row.project_id);
  });
}

/**
 * The running subscriber handle: coordinates every queued project once on start,
 * then coordinates a project whenever one of its runs reaches a state change.
 * `stop()` unsubscribes (idempotent). Per-project passes are coalesced so a storm
 * of notifications collapses into at most one in-flight pass + one queued re-pass.
 */
export class MergeCoordinatorSubscriber {
  private readonly coordinator: MergeCoordinator;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rePending = new Set<string>();

  constructor(private readonly deps: MergeCoordinatorSubscriberDeps) {
    this.coordinator = deps.coordinator ?? this.buildProductionCoordinator();
  }

  private buildProductionCoordinator(): MergeCoordinator {
    const { secrets, vcsProvider } = this.deps;
    if (secrets === undefined || vcsProvider === undefined) {
      throw new Error("MergeCoordinatorSubscriber requires secrets + vcsProvider when no coordinator is injected");
    }
    // P2d-2: the native-queue driver is the speculative batch-check + bisect
    // coordinator (it forms a batch, proves the prospective merged state green as a
    // unit, then drives the SAME P2d-1 per-run merges in DAG order — a bad interaction
    // is bisected to one PR rather than stalling the batch).
    return buildBatchMergeCoordinator({
      pool: this.deps.pool,
      secrets,
      vcsProvider,
      ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    void this.subscribeInBackground();
    void this.driveAllProjects();
  }

  private async subscribeInBackground(): Promise<void> {
    try {
      const unsubscribe = await this.deps.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
        void this.onRunActivity(payload).catch((error: unknown) => {
          console.error(`[merge-coordinator] run-activity handler failed for run ${payload}:`, error);
        });
      });
      if (this.stopped) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
    } catch (error) {
      console.error("[merge-coordinator] failed to subscribe to the run-activity bus (will not auto-advance):", error);
    }
  }

  private async driveAllProjects(): Promise<void> {
    try {
      const projectIds = await listProjectsWithQueue(this.deps.pool);
      await Promise.all(projectIds.map((projectId) => this.schedule(projectId)));
    } catch (error) {
      console.error("[merge-coordinator] initial queue drive failed (will drive on the next notification):", error);
    }
  }

  /** Stop listening. Idempotent; in-flight passes finish on their own. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async onRunActivity(runId: string): Promise<void> {
    if (runId === "") return;
    const projectId = await resolveRunProject(this.deps.pool, runId);
    if (projectId === undefined) return;
    await this.schedule(projectId);
  }

  /** Coordinate a project, coalescing concurrent requests (latest state, once). */
  private schedule(projectId: string): Promise<void> {
    const existing = this.inFlight.get(projectId);
    if (existing !== undefined) {
      this.rePending.add(projectId);
      return existing;
    }
    const run = this.runChain(projectId).finally(() => {
      this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, run);
    return run;
  }

  /** Coordinate, then re-coordinate while a trigger arrived mid-pass. */
  private async runChain(projectId: string): Promise<void> {
    do {
      this.rePending.delete(projectId);
      await this.coordinator.coordinate(projectId).catch((error: unknown) => {
        console.error(`[merge-coordinator] coordinate pass failed for project ${projectId}:`, error);
      });
    } while (this.rePending.has(projectId));
  }
}

/** Build + start the MergeCoordinator subscriber from the worker boot. */
export async function startMergeCoordinatorSubscriber(
  deps: MergeCoordinatorSubscriberDeps,
): Promise<MergeCoordinatorSubscriber> {
  const subscriber = new MergeCoordinatorSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
