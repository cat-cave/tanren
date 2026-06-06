// Production MergeCoordinator (autonomy-engine.md §2d): a per-project scheduler over
// the existing per-run merge path. It orders ready runs in DAG order, serializes one
// merge at a time, and relies on `coordinatorPg.ts` for pg queue/event wirings.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import {
  type CoordinateResult,
  type DequeueReason,
  type MergeCoordinator,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
  selectNextMerge,
} from "../contracts/mergeCoordinator.js";
import { isRetriableInfraError } from "../providers/githubRefReset.js";
import { isAmbiguousMergeError } from "../providers/mergeOutcomeErrors.js";
import type { SpecEscalator } from "./coordinatorEscalate.js";
import { holdOrHaltRecoverableDrive, RecoverableDriveHoldCeiling } from "./recoverableDriveHold.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";
import { isMissingRequiredCredentialError, missingRequiredCredentialMessage } from "./missingRequiredCredential.js";
import type { MergeTruthReconciler } from "./mergeTruthReconciler.js";

/** How long after a transient merge-drive infra-hold the subscriber re-drives the project. */
const TRANSIENT_DRIVE_HOLD_RETRY_AFTER_MS = 3000;
/** Longer re-drive delay after a ceiling alert so persistent outages do not hot-loop. */
const TRANSIENT_DRIVE_HOLD_ALERT_RETRY_AFTER_MS = 60_000;

/**
 * GAP #2c: the hold-attempt CEILING — how many CONSECUTIVE transient infra re-drives one
 * entry may take before the coordinator stops re-arming the 3s timer and emits a LOUD
 * ceiling alert. Bounds the recover-on-transient loop so a persistent outage (or a
 * logic-bug masquerading as infra) surfaces loudly instead of re-driving forever on the
 * short timer. The entry stays queued and retries with a longer backoff so recovery
 * remains autonomous. The common case (a GitHub blip) recovers in 1–2 re-drives, well
 * under this.
 */
const MAX_INFRA_HOLD_ATTEMPTS = 5;

/**
 * Drives ONE queued run's merge through the existing per-run merge path. The
 * worker boot supplies this as a closure over `mergeForRun` in `native_queue`
 * DRIVE mode (the SAME directMerge logic — up-to-date/conflict-resolution/retarget) so this module does not
 * import the heavy run-loop seam graph. Tests inject a fake runner directly.
 */
export type DriveMergeForQueuedRun = (input: { runId: string; projectId: string }) => Promise<MergeDriveOutcome>;

/** What the coordinator needs to emit the queue events (org-scoped, eventStore). */
export interface MergeQueueEventEmitter {
  /** merge.queue.advanced: the coordinator selected the DAG-ordered head to merge. */
  emitAdvanced(input: { projectId: string; entry: MergeQueueEntry; queueDepth: number }): Promise<void>;
  /** merge.dequeued: an entry left the queue without merging (conflict/blocked/failed/superseded). */
  emitDequeued(input: {
    projectId: string;
    entry: MergeQueueEntry;
    reason: DequeueReason;
    message: string;
  }): Promise<void>;
  /**
   * merge.queue.infra_blocked (GAP #2d): a transient merge-drive infra error could no
   * longer continue on the short retry — the entry exhausted its re-drive ceiling, or
   * the merge state was unconfirmable (auto-retry could double-merge). A LOUD
   * operator-visible alert/halt.
   */
  emitInfraBlocked(input: {
    projectId: string;
    entry: MergeQueueEntry;
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
    attempts: number;
    message: string;
  }): Promise<void>;
}

export interface MergeCoordinatorDeps {
  queue: MergeQueueModel;
  runner: MergeRunner;
  events: MergeQueueEventEmitter;
  mergeTruth?: MergeTruthReconciler;
  /**
   * The NON-BRICKING conflict-escalation seam (§2c): parks a GENUINELY irreconcilable
   * spec at `needs_attention` (frees its slot) + emits the loud `dag.spec.needs_attention`
   * when the drive returns the `needs_attention` outcome. Reused verbatim by the batch
   * coordinator so the two paths can never diverge.
   */
  escalator: SpecEscalator;
}

/**
 * Queue/event split-brain guard: terminal dequeue is never made durable before its
 * durable event. If the event append fails, the entry remains active (`merging` or
 * `queued`) and the failure is visible to the coordinator instead of producing an
 * invisible dequeued row that startup/recovery cannot reason about.
 */
export async function markDequeuedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  reason: DequeueReason;
  message: string;
}): Promise<void> {
  await input.events.emitDequeued({
    projectId: input.projectId,
    entry: input.entry,
    reason: input.reason,
    message: input.message,
  });
  await input.queue.markDequeued(input.entry.queueId, input.reason);
}

export async function markInfraBlockedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  kind: "ceiling" | "ambiguous" | "missing_required_credential";
  attempts: number;
  message: string;
}): Promise<void> {
  await input.events.emitInfraBlocked({
    projectId: input.projectId,
    entry: input.entry,
    kind: input.kind,
    attempts: input.attempts,
    message: input.message,
  });
  await input.queue.markDequeued(input.entry.queueId, "blocked");
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
   * settle (merged / dequeued / ceiling-alert) so a recovered entry starts fresh.
   */
  private readonly infraHoldAttempts = new Map<string, number>();
  private readonly recoverableDriveHolds = new RecoverableDriveHoldCeiling();

  constructor(private readonly deps: MergeCoordinatorDeps) {}

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // Crash recovery FIRST: a coordinator that died mid-merge left a `merging`
    // row; return it to `queued` so this pass re-considers it (the GitHub merge is
    // idempotent, so re-driving an already-merged PR is a no-op).
    await this.deps.mergeTruth?.reconcile(projectId);
    await this.deps.queue.recoverStaleClaims(projectId);
    await this.deps.queue.recoverDequeuedCandidates(projectId);

    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const selection = selectNextMerge(snapshot);
    const queueDepth = snapshot.entries.length;

    if (selection.next === undefined) {
      return {
        projectId,
        holdReason: selection.holdReason,
        queueDepth,
        ...(selection.holdReason === "serialized" && { retryAfterMs: serializedRetryAfterMs(snapshot) }),
      };
    }
    const entry = selection.next;

    // The atomic serialization lock: only the pass that wins the claim drives the
    // merge. A concurrent pass that lost re-evaluates on its own next trigger.
    const claimed = await this.deps.queue.claim(entry.queueId);
    if (!claimed) {
      const refreshed = await this.deps.queue.loadSnapshot(projectId);
      return { projectId, holdReason: "serialized", queueDepth, retryAfterMs: serializedRetryAfterMs(refreshed) };
    }

    await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

    const outcome = await this.driveAndSettle(projectId, entry);
    return { projectId, queueDepth, ...outcome };
  }

  /**
   * Drive the claimed entry's merge through the existing per-run merge path and
   * settle the queue row from the outcome. A `merged` outcome marks the entry
   * merged (the next pass picks the next DAG head); a `blocked` outcome releases
   * the claim with bounded backoff; a conflict/failed outcome DEQUEUES it (it leaves
   * the ready set so independent items proceed) and emits merge.dequeued.
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
   *     a LOUD `merge.queue.infra_blocked` alert, keeps the entry queued, and re-drives
   *     with longer backoff so it cannot hot-loop or permanently strand.
   *   - a typed PERMANENT infra error → the recoverable `blocked` hold path.
   * A GENUINE returned block holds with bounded backoff; a returned conflict/failed
   * still dequeues.
   */
  private async driveAndSettle(
    projectId: string,
    entry: MergeQueueEntry,
  ): Promise<{
    mergedSpecId?: string;
    dequeuedSpecId?: string;
    holdReason?: "infra_error" | "merge_retry";
    retryAfterMs?: number;
  }> {
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
          return this.holdInfraBlockedAfterCeiling(
            projectId,
            entry,
            `merge drive kept throwing a transient infra error after ${attempts} re-drives: ${String(error)}`,
            attempts,
          );
        }
        this.recoverableDriveHolds.reset(entry.queueId);
        this.infraHoldAttempts.set(entry.queueId, attempts);
        // Release the claim so the entry stays queued, then HOLD loudly + arm a re-drive.
        await this.deps.queue.releaseClaim(entry.queueId);
        console.warn(
          `[merge-coordinator] project ${projectId}: merge drive for spec ${entry.specId} threw a transient infra error (attempt ${attempts}/${MAX_INFRA_HOLD_ATTEMPTS}); holding + re-driving (entry stays queued):`,
          error,
        );
        return { holdReason: "infra_error", retryAfterMs: TRANSIENT_DRIVE_HOLD_RETRY_AFTER_MS };
      }
      if (isMissingRequiredCredentialError(error)) {
        return this.haltInfraBlocked(
          projectId,
          entry,
          "missing_required_credential",
          `merge drive cannot run until required credential/config is repaired: ${missingRequiredCredentialMessage(error)}`,
        );
      }
      // A non-retriable thrown error is a genuine (typed-permanent) infra block: route
      // through the recoverable `blocked` hold path, which alerts at its ceiling without
      // permanently removing the candidate.
      outcome = { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }

    // Any settled (non-held) outcome ends this entry's infra-hold streak.
    this.infraHoldAttempts.delete(entry.queueId);

    if (outcome.kind === "merged") {
      this.recoverableDriveHolds.reset(entry.queueId);
      await this.deps.queue.markMerged(entry.queueId);
      // The merge stage itself emits merge.completed (it owns the real merge); the
      // coordinator does not double-emit it. The next pass (re-triggered by that
      // merge.completed on the bus) selects the next DAG head.
      return { mergedSpecId: entry.specId };
    }

    if (outcome.kind === "needs_attention") {
      this.recoverableDriveHolds.reset(entry.queueId);
      // The LOUD TERMINAL ESCALATION (§2c — non-bricking): the resolver judged this spec
      // GENUINELY irreconcilable. PARK it at `needs_attention` (frees its slot — the rest
      // of the DAG keeps moving) FIRST, then dequeue `needs_attention` (the entry leaves
      // the ready set, NEVER re-queued). NOT routed through the recoverable `conflict`
      // path — re-executing it would just re-conflict forever. The escalator emits the
      // loud `dag.spec.needs_attention`; the dequeue emits `merge.dequeued`.
      await this.deps.escalator.escalate({ projectId, entry, message: outcome.message });
      await markDequeuedAfterEvent({
        queue: this.deps.queue,
        events: this.deps.events,
        projectId,
        entry,
        reason: "needs_attention",
        message: outcome.message,
      });
      return { dequeuedSpecId: entry.specId };
    }

    if (outcome.kind === "blocked") {
      const held = await holdOrHaltRecoverableDrive({
        ceiling: this.recoverableDriveHolds,
        queue: this.deps.queue,
        events: this.deps.events,
        projectId,
        entry,
        outcome,
      });
      return { holdReason: "merge_retry", retryAfterMs: held.retryAfterMs };
    }

    // A returned `conflict` usually means the resolver already routed an
    // autonomous re-plan; a terminal merge-stage failure also leaves the queue.
    this.recoverableDriveHolds.reset(entry.queueId);
    const reason = outcome.kind;
    await markDequeuedAfterEvent({
      queue: this.deps.queue,
      events: this.deps.events,
      projectId,
      entry,
      reason,
      message: outcome.message,
    });
    return { dequeuedSpecId: entry.specId };
  }

  /**
   * GAP #2d/#2c: the LOUD operator-visible infra HALT for ambiguous merge state only.
   * The merge state is unconfirmable after a 5xx, so auto-retry could double-merge. It
   * dequeues the entry + emits `merge.queue.infra_blocked`, and crucially returns NO
   * `retryAfterMs` so the subscriber arms no further timer. Retriable ceiling alerts use
   * `holdInfraBlockedAfterCeiling` instead and keep the candidate active.
   */
  private async haltInfraBlocked(
    projectId: string,
    entry: MergeQueueEntry,
    kind: "ceiling" | "ambiguous" | "missing_required_credential",
    message: string,
    attempts = this.infraHoldAttempts.get(entry.queueId) ?? 0,
  ): Promise<{ dequeuedSpecId: string }> {
    this.infraHoldAttempts.delete(entry.queueId);
    this.recoverableDriveHolds.reset(entry.queueId);
    await markInfraBlockedAfterEvent({
      queue: this.deps.queue,
      events: this.deps.events,
      projectId,
      entry,
      kind,
      attempts,
      message,
    });
    console.error(
      `[merge-coordinator] project ${projectId}: merge drive for spec ${entry.specId} HALTED (${kind}) after ${attempts} infra re-drive(s); operator attention required: ${message}`,
    );
    return { dequeuedSpecId: entry.specId };
  }

  /**
   * GAP #2d root fix: a retriable single-entry ceiling is an alert, not a permanent
   * queue removal. Emit the same observable `merge.queue.infra_blocked` ceiling signal,
   * reset the short-streak counter, release the claim, and keep autonomous re-drive alive
   * with a longer backoff. If the event append fails, the fresh `merging` claim remains
   * active and normal lease recovery re-queues it instead of silently losing the alert.
   */
  private async holdInfraBlockedAfterCeiling(
    projectId: string,
    entry: MergeQueueEntry,
    message: string,
    attempts: number,
  ): Promise<{ holdReason: "infra_error"; retryAfterMs: number }> {
    this.infraHoldAttempts.delete(entry.queueId);
    this.recoverableDriveHolds.reset(entry.queueId);
    await this.deps.events.emitInfraBlocked({
      projectId,
      entry,
      kind: "ceiling",
      attempts,
      message,
    });
    await this.deps.queue.releaseClaim(entry.queueId);
    console.error(
      `[merge-coordinator] project ${projectId}: merge drive for spec ${entry.specId} ALERTED after ${attempts} infra re-drive(s); continuing autonomous re-drive after backoff: ${message}`,
    );
    return { holdReason: "infra_error", retryAfterMs: TRANSIENT_DRIVE_HOLD_ALERT_RETRY_AFTER_MS };
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
    reason: DequeueReason;
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
    kind: "ceiling" | "ambiguous" | "missing_required_credential";
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
