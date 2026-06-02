// The production MergeCoordinator (autonomy-engine.md §2d — the native intelligent
// merge queue, the headline P2d capability). A per-project SCHEDULER over the
// EXISTING per-run merge path: it orders ready-to-merge runs in DAG order
// (ancestor before dependent, priority within a layer) and SERIALIZES their merges
// (one at a time) by driving `mergeForRun` in its `native_queue` DRIVE mode — it
// does NOT implement a second merge path. The queue logic is pure Tanren
// (`selectNextMerge`); only the VCS/CI calls inside the merge stage go through the
// VcsProvider, so the coordinator is provider-agnostic.
//
// Each pass (`coordinate(projectId)`): recover stale claims (crash recovery) → load
// the queue snapshot under RLS → select the single DAG-ordered head (or hold) →
// atomically claim it (serialization lock) → drive its merge → record the outcome +
// emit the queue events. The LISTEN/NOTIFY subscriber (subscriber.ts) drives it on
// startup + on every run-terminal / merge.completed notification, so a freshly
// ready run + a freshly merged ancestor both re-trigger the queue.
//
// The pg seam wirings (queue model + merge runner) live in `coordinatorPg.ts`.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import {
  type CoordinateResult,
  type MergeCoordinator,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
  selectNextMerge,
} from "../contracts/mergeCoordinator.js";

/**
 * Drives ONE queued run's merge through the existing per-run merge path. The
 * worker boot supplies this as a closure over `mergeForRun` in `native_queue`
 * DRIVE mode (the SAME directMerge logic — P2a/P2b/P2c-1) so this module does not
 * import the heavy run-loop seam graph. Tests inject a fake runner directly.
 */
export type DriveMergeForQueuedRun = (input: { runId: string; projectId: string }) => Promise<MergeDriveOutcome>;

/** What the coordinator needs to emit the queue events (org-scoped, eventStore). */
export interface MergeQueueEventEmitter {
  /** merge.queue.advanced: the coordinator selected the DAG-ordered head to merge. */
  emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void>;
  /** merge.dequeued: an entry left the queue without merging (conflict/blocked/failed). */
  emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: "conflict" | "blocked" | "failed";
    message: string;
  }): Promise<void>;
}

export interface MergeCoordinatorDeps {
  queue: MergeQueueModel;
  runner: MergeRunner;
  events: MergeQueueEventEmitter;
}

/**
 * The production MergeCoordinator. One `coordinate(projectId)` pass merges AT MOST
 * ONE entry (serialization). It reloads the queue every pass (DAG state is the
 * source of truth, never cached): a merge completing re-triggers the coordinator,
 * which then picks the next DAG-ordered head — so A merges, then B, then C in
 * dependency order. A conflict/blocked/failed head DEQUEUES (leaves the ready set)
 * so independent later items proceed (liveness) and the head never deadlocks.
 */
export class EventEmittingMergeCoordinator implements MergeCoordinator {
  constructor(private readonly deps: MergeCoordinatorDeps) {}

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // Crash recovery FIRST: a coordinator that died mid-merge left a `merging`
    // row; return it to `queued` so this pass re-considers it (the GitHub merge is
    // idempotent, so re-driving an already-merged PR is a no-op).
    await this.deps.queue.recoverStaleClaims(projectId);

    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const selection = selectNextMerge(snapshot);
    const queueDepth = snapshot.entries.length;

    if (selection.next === undefined) {
      return { projectId, holdReason: selection.holdReason, queueDepth };
    }
    const entry = selection.next;

    // The atomic serialization lock: only the pass that wins the claim drives the
    // merge. A concurrent pass that lost re-evaluates on its own next trigger.
    const claimed = await this.deps.queue.claim(entry.queueId);
    if (!claimed) {
      return { projectId, holdReason: "serialized", queueDepth };
    }

    await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

    const outcome = await this.driveAndSettle(projectId, entry);
    return { projectId, queueDepth, ...outcome };
  }

  /**
   * Drive the claimed entry's merge through the existing per-run merge path and
   * settle the queue row from the outcome. A `merged` outcome marks the entry
   * merged (the next pass picks the next DAG head); a conflict/blocked/failed
   * outcome DEQUEUES it (it leaves the ready set so independent items proceed) and
   * emits merge.dequeued — conflict/blocked are recoverable (a re-ready run
   * re-enqueues a new entry), failed is terminal. A THROWN drive (e.g. a transient
   * VCS error) is treated as a recoverable `blocked` dequeue, never a stuck
   * `merging` claim — so the head never deadlocks.
   */
  private async driveAndSettle(
    projectId: string,
    entry: MergeQueueEntry,
  ): Promise<{ mergedSpecId?: string; dequeuedSpecId?: string }> {
    let outcome: MergeDriveOutcome;
    try {
      outcome = await this.deps.runner.driveMerge({ runId: entry.runId, projectId });
    } catch (error) {
      outcome = { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }

    if (outcome.kind === "merged") {
      await this.deps.queue.markMerged(entry.queueId);
      // The merge stage itself emits merge.completed (it owns the real merge); the
      // coordinator does not double-emit it. The next pass (re-triggered by that
      // merge.completed on the bus) selects the next DAG head.
      return { mergedSpecId: entry.specId };
    }

    // The dequeue reason: "conflict" | "blocked" | "failed".
    const reason = outcome.kind;
    await this.deps.queue.markDequeued(entry.queueId, reason);
    await this.deps.events.emitDequeued({ projectId, entry, reason, message: outcome.message });
    return { dequeuedSpecId: entry.specId };
  }
}

/**
 * The pg-backed queue-event emitter. Resolves the project's org, then writes each
 * event through the org-scoped PgEventStore (the single event-writer seam). The
 * events carry the entry's run/spec so the timeline links the queue decision to
 * the run, and the queue depth for queue/stack statistics (§2d).
 */
export class PgMergeQueueEventEmitter implements MergeQueueEventEmitter {
  constructor(private readonly pool: pg.Pool) {}

  private async withScopedStore(projectId: string, work: (store: PgEventStore) => Promise<void>): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, (client) => work(new PgEventStore(client)));
  }

  async emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.entry.runId,
        specId: input.entry.specId,
        projectId: input.projectId,
        eventType: "merge.queue.advanced",
        payload: {
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
          integration: "native_queue",
          specId: input.entry.specId,
          queueDepth: input.queueDepth,
        },
      }),
    );
  }

  async emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: "conflict" | "blocked" | "failed";
    message: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.entry.runId,
        specId: input.entry.specId,
        projectId: input.projectId,
        eventType: "merge.dequeued",
        payload: {
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
          integration: "native_queue",
          specId: input.entry.specId,
          reason: input.reason,
          message: input.message,
        },
      }),
    );
  }
}
