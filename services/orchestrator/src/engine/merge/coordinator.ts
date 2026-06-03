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

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import {
  type CoordinateResult,
  type MergeCoordinator,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
  selectNextMerge,
} from "../contracts/mergeCoordinator.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";
import { isAmbiguousMergeError } from "../providers/mergeOutcomeErrors.js";

/** How long after a transient merge-drive infra-hold the subscriber re-drives the project. */
const TRANSIENT_DRIVE_HOLD_RETRY_AFTER_MS = 3000;
/**
 * GAP #2c: the hold-attempt CEILING — how many CONSECUTIVE transient infra re-drives one
 * entry may take before the coordinator stops re-arming the 3s timer and emits a LOUD
 * terminal halt. Bounds the recover-on-transient loop so a persistent outage (or a
 * logic-bug masquerading as infra) surfaces loudly instead of re-driving forever. The
 * common case (a GitHub blip) recovers in 1–2 re-drives, well under this.
 */
const MAX_INFRA_HOLD_ATTEMPTS = 5;

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
  /**
   * merge.queue.infra_blocked (GAP #2d): a transient merge-drive infra error could no
   * longer recover on its own — the entry exhausted its re-drive ceiling, or the merge
   * state was unconfirmable (auto-retry could double-merge). A LOUD operator-visible halt.
   */
  emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous";
    attempts: number;
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
  /**
   * GAP #2c: per-entry CONSECUTIVE transient-infra-hold counter (queueId → count). In
   * memory by design — the coordinator+subscriber are a single long-lived per-worker
   * singleton, so the count survives across `coordinate` passes (each re-drive is a
   * fresh pass). A crash resets it, which is correct: `recoverStaleClaims` re-queues the
   * entry, and re-driving an idempotent merge is safe. Reset on any non-infra-hold
   * settle (merged / dequeued / ceiling-halt) so a recovered entry starts fresh.
   */
  private readonly infraHoldAttempts = new Map<string, number>();

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
   * re-enqueues a new entry), failed is terminal.
   *
   * GitHub-5xx resilience (GAP #2d): a THROWN drive used to become a `blocked` dequeue —
   * but a `done` run NEVER re-readies, so a transient 504 mid-drive would STRAND a clean
   * PR. A thrown error is now classified three ways:
   *   - AMBIGUOUS merge (`MergeAmbiguousError`) → a LOUD `merge.queue.infra_blocked`
   *     halt that does NOT auto-re-drive (re-PUTting could double-merge); the entry is
   *     removed (operator decides) rather than silently held forever.
   *   - RETRIABLE transient/infra (`isRetriableInfraError` — a 5xx/network blip OR the
   *     typed `MergeTransientError` the persistent merge-PUT throws once it confirms the
   *     PR is still open+unmerged) → RELEASE the claim (entry stays queued) + HOLD with
   *     `holdReason: "infra_error"` + `retryAfterMs` so the subscriber re-drives once the
   *     gateway recovers — BOUNDED by `MAX_INFRA_HOLD_ATTEMPTS`: at the ceiling it emits
   *     a LOUD `merge.queue.infra_blocked` halt + dequeues so it cannot loop forever.
   *   - a typed PERMANENT infra error → the prior recoverable `blocked` dequeue.
   * A GENUINE block/conflict the drive RETURNS keeps its existing dequeue handling.
   */
  private async driveAndSettle(
    projectId: string,
    entry: MergeQueueEntry,
  ): Promise<{ mergedSpecId?: string; dequeuedSpecId?: string; holdReason?: "infra_error"; retryAfterMs?: number }> {
    let outcome: MergeDriveOutcome;
    try {
      outcome = await this.deps.runner.driveMerge({ runId: entry.runId, projectId });
    } catch (error) {
      // AMBIGUOUS merge: the merge PUT 5xx'd and the merged state is unconfirmable —
      // auto-re-driving could DOUBLE-MERGE. Loud halt, NO re-drive (operator attention).
      if (isAmbiguousMergeError(error)) {
        return this.haltInfraBlocked(projectId, entry, "ambiguous", error.message);
      }
      if (isRetriableInfraError(error)) {
        // Transient/infra throw: do NOT dequeue (that would strand a clean PR). Bounded by
        // the hold-attempt ceiling so it cannot recover-loop forever on a persistent outage.
        const attempts = (this.infraHoldAttempts.get(entry.queueId) ?? 0) + 1;
        if (attempts >= MAX_INFRA_HOLD_ATTEMPTS) {
          return this.haltInfraBlocked(
            projectId,
            entry,
            "ceiling",
            `merge drive kept throwing a transient infra error after ${attempts} re-drives: ${String(error)}`,
            attempts,
          );
        }
        this.infraHoldAttempts.set(entry.queueId, attempts);
        // Release the claim so the entry stays queued, then HOLD loudly + arm a re-drive.
        await this.deps.queue.releaseClaim(entry.queueId);
        console.warn(
          `[merge-coordinator] project ${projectId}: merge drive for spec ${entry.specId} threw a transient infra error (attempt ${attempts}/${MAX_INFRA_HOLD_ATTEMPTS}); holding + re-driving (entry stays queued):`,
          error,
        );
        return { holdReason: "infra_error", retryAfterMs: TRANSIENT_DRIVE_HOLD_RETRY_AFTER_MS };
      }
      // A non-retriable thrown error is a genuine (typed-permanent) infra block: keep
      // the prior recoverable `blocked` dequeue (it leaves the head; never deadlocks).
      outcome = { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }

    // Any settled (non-held) outcome ends this entry's infra-hold streak.
    this.infraHoldAttempts.delete(entry.queueId);

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

  /**
   * GAP #2d/#2c: the LOUD operator-visible infra HALT — emitted when a transient
   * merge-drive error can no longer recover on its own: the hold-attempt CEILING was
   * reached (a persistent outage / a logic-bug-as-infra), or the merge state is
   * AMBIGUOUS (unconfirmable after a 5xx — auto-retry could double-merge). It dequeues
   * the entry (so it does NOT re-drive forever) + emits `merge.queue.infra_blocked`, and
   * crucially returns NO `retryAfterMs` so the subscriber arms no further timer. Resets
   * the entry's infra-hold streak.
   */
  private async haltInfraBlocked(
    projectId: string,
    entry: MergeQueueEntry,
    kind: "ceiling" | "ambiguous",
    message: string,
    attempts = this.infraHoldAttempts.get(entry.queueId) ?? 0,
  ): Promise<{ dequeuedSpecId: string }> {
    this.infraHoldAttempts.delete(entry.queueId);
    await this.deps.queue.markDequeued(entry.queueId, "blocked");
    await this.deps.events.emitInfraBlocked({ projectId, entry, kind, attempts, message });
    console.error(
      `[merge-coordinator] project ${projectId}: merge drive for spec ${entry.specId} HALTED (${kind}) after ${attempts} infra re-drive(s); operator attention required: ${message}`,
    );
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
  /**
   * @param runStateWriter Plane-split (autonomy loops): when present, queue events
   *   append through the control-plane writer (the de-privileged data plane can no
   *   longer write `events` directly); absent, in-process via `PgEventStore`.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter?: RunStateWriter,
  ) {}

  private async withScopedStore(projectId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return;
    // Plane-split: route the event append through the control plane when wired (the
    // writer resolves the run's org from the ambient per-job org-id, so set it for
    // the append); else append in-process under a short org scope — byte-identical.
    if (this.runStateWriter !== undefined) {
      const writer = this.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
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

  async emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous";
    attempts: number;
    message: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.entry.runId,
        specId: input.entry.specId,
        projectId: input.projectId,
        eventType: "merge.queue.infra_blocked",
        payload: {
          prUrl: input.entry.prUrl,
          prNumber: input.entry.prNumber,
          integration: "native_queue",
          specId: input.entry.specId,
          kind: input.kind,
          attempts: input.attempts,
          message: input.message,
        },
      }),
    );
  }
}
