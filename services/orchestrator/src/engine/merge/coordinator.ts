// Production MergeCoordinator (autonomy-engine.md §2d): a per-project scheduler over
// the existing per-run merge path. It orders ready runs in DAG order, serializes one
// merge at a time, and relies on `coordinatorPg.ts` for pg queue/event wirings.

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
import { infraThrowSignature } from "./infraNonRecovery.js";
import { serializedRetryAfterMs } from "./mergeSerializedRetry.js";
import { isMissingRequiredCredentialError, missingRequiredCredentialMessage } from "./missingRequiredCredential.js";
import type { HoldCeilingStore } from "./holdCeilingStore.js";
import { alertRetryAfterMs } from "./retrySchedule.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("merge-coordinator");

/**
 * How long after a NOT-YET-TERMINAL native re-gate the subscriber re-drives the project. A
 * `re_gate_pending` outcome means the post-auto-rebase gate is STILL RUNNING / had an infra
 * blip ("not done yet") — the entry stays QUEUED and is re-driven on this paced timer until
 * the gate reaches a terminal verdict. This is NEVER bounded by a fixed attempt cap (a
 * still-running gate is never "non-convergence" — a human would say "wait for it"); a
 * genuinely-stuck gate surfaces via the OTHER signals (a thrown ambiguous/credential infra
 * halt, or a terminal failed/needs_attention verdict), not a count on this hold.
 */
const RE_GATE_PENDING_RETRY_AFTER_MS = alertRetryAfterMs;
/** Longer re-drive delay after a non-recovery alert so persistent outages do not hot-loop (single source: retrySchedule). */
const TRANSIENT_DRIVE_HOLD_ALERT_RETRY_AFTER_MS = alertRetryAfterMs;

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
  /**
   * The NON-BRICKING conflict-escalation seam (§2c): parks a GENUINELY irreconcilable
   * spec at `needs_attention` (frees its slot) + emits the loud `dag.spec.needs_attention`
   * when the drive returns the `needs_attention` outcome. Reused verbatim by the batch
   * coordinator so the two paths can never diverge.
   */
  escalator: SpecEscalator;
  /**
   * ATOMICITY SEAM (audit RC-4 #3): when wired, the dequeue/infra-blocked settle runs
   * its event append + queue UPDATE in ONE transaction (both-commit-or-both-roll-back),
   * closing the crash-between-writes split brain. Optional: absent, the settle falls
   * back to the sequential event-first path (unchanged ordering + split-brain guard).
   */
  tx?: MergeSettleTransaction;
  /**
   * Audit RC-7: the DURABLE backing store for the per-entry recoverable-drive hold
   * ceiling. When wired (the production assembly injects the {@link PgHoldCeilingStore}),
   * the attempt counter survives a rolling deploy / crash-loop instead of resetting in a
   * process-local Map. Absent → an in-memory store (the in-process fakes / unit tests).
   */
  holdCeilingStore?: HoldCeilingStore;
}

/**
 * ATOMICITY SEAM (audit RC-4 #3): the both-or-neither settle transaction. The
 * `markDequeuedAfterEvent` / `markInfraBlockedAfterEvent` paths emit a durable queue
 * event AND flip the `merge_queue` row to `dequeued`. Without a shared transaction a
 * crash BETWEEN the two committed writes leaves a split brain: the event bus says the
 * entry dequeued while the row is still `merging` (or vice versa). This seam runs both
 * writes on ONE org-scoped transaction so they COMMIT together or ROLL BACK together.
 *
 * The event-first ORDERING is preserved INSIDE the transaction (the event append is
 * issued before the row UPDATE) so the long-standing split-brain guard still holds: a
 * failing event append rolls back the whole unit, leaving the entry active and the
 * failure visible to the coordinator. When no runner is wired (the in-memory fakes do
 * inject one; a caller that does not falls back to the sequential path), the prior
 * emit-then-update ordering runs unchanged.
 */
export interface MergeSettleTransaction {
  /**
   * Run `work` inside ONE org-scoped transaction for `projectId`. The `events` +
   * `queue` handed to `work` write through the SAME client, so the event append and
   * the queue settle either both commit or both roll back. `work` must issue the
   * event append BEFORE the queue update to preserve the event-first ordering.
   */
  run(
    projectId: string,
    work: (ctx: { events: MergeQueueEventEmitter; queue: MergeQueueModel }) => Promise<void>,
  ): Promise<void>;
}

/**
 * Queue/event split-brain guard + ATOMICITY (audit RC-4 #3): terminal dequeue is
 * never made durable before its durable event, AND — when a {@link MergeSettleTransaction}
 * is wired — the event append and the row UPDATE run in ONE transaction (both-commit-or-
 * both-roll-back), so a crash between them can never leave the bus saying "dequeued"
 * while the row is still `merging`. Without a runner the sequential emit-then-update
 * path runs (the event-first guard still holds: a failed append leaves the entry active).
 */
export async function markDequeuedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  reason: DequeueReason;
  message: string;
  tx?: MergeSettleTransaction;
}): Promise<void> {
  const settle = async (events: MergeQueueEventEmitter, queue: MergeQueueModel): Promise<void> => {
    // EVENT-FIRST inside the transaction: the durable event precedes the row UPDATE, so
    // a failing append rolls back the whole unit and the entry stays active/visible.
    await events.emitDequeued({
      projectId: input.projectId,
      entry: input.entry,
      reason: input.reason,
      message: input.message,
    });
    await queue.markDequeued(input.entry.queueId, input.reason);
  };
  if (input.tx !== undefined) {
    await input.tx.run(input.projectId, (ctx) => settle(ctx.events, ctx.queue));
    return;
  }
  await settle(input.events, input.queue);
}

export async function markInfraBlockedAfterEvent(input: {
  queue: MergeQueueModel;
  events: MergeQueueEventEmitter;
  projectId: string;
  entry: MergeQueueEntry;
  kind: "ceiling" | "ambiguous" | "missing_required_credential";
  attempts: number;
  message: string;
  tx?: MergeSettleTransaction;
}): Promise<void> {
  const settle = async (events: MergeQueueEventEmitter, queue: MergeQueueModel): Promise<void> => {
    await events.emitInfraBlocked({
      projectId: input.projectId,
      entry: input.entry,
      kind: input.kind,
      attempts: input.attempts,
      message: input.message,
    });
    await queue.markDequeued(input.entry.queueId, "blocked");
  };
  if (input.tx !== undefined) {
    await input.tx.run(input.projectId, (ctx) => settle(ctx.events, ctx.queue));
    return;
  }
  await settle(input.events, input.queue);
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
  private readonly recoverableDriveHolds: RecoverableDriveHoldCeiling;

  constructor(private readonly deps: MergeCoordinatorDeps) {
    // Audit RC-7: back the per-entry recoverable-drive ceiling with the injected durable
    // store so the attempt counter survives a restart (the in-memory default keeps fakes Pg-free).
    this.recoverableDriveHolds = new RecoverableDriveHoldCeiling(deps.holdCeilingStore);
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // Crash recovery FIRST: a coordinator that died mid-merge left a `merging`
    // row; return it to `queued` so this pass re-considers it (the GitHub merge is
    // idempotent, so re-driving an already-merged PR is a no-op).
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
   * the claim with bounded backoff; a conflict dequeues only with a typed recovery
   * receipt, while an ownerless failure parks loudly at needs_attention.
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
   *     gateway recovers — guarded by SUSTAINED-NON-RECOVERY (a PROGRESS signal, not a
   *     count): once the SAME infra failure signature persists with no progress across the
   *     backoff-spaced re-drives it emits a LOUD `merge.queue.infra_blocked` alert, keeps
   *     the entry queued, and re-drives with longer backoff so it cannot hot-loop or
   *     permanently strand. A SHIFTING failure keeps recovering quietly (no alert).
   *   - a typed PERMANENT infra error → the recoverable `blocked` hold path.
   * A GENUINE returned block holds with bounded backoff; conflict/failed retirement
   * requires recovery ownership or a loud needs_attention park.
   */
  private async driveAndSettle(
    projectId: string,
    entry: MergeQueueEntry,
  ): Promise<{
    mergedSpecId?: string;
    dequeuedSpecId?: string;
    holdReason?: "infra_error" | "merge_retry" | "re_gate_pending";
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
        // Transient/infra throw: do NOT dequeue (that would strand a clean PR). Guarded by
        // SUSTAINED-NON-RECOVERY (a progress signal, not a count) so it cannot recover-loop
        // forever on a persistent outage: record the thrown failure's signature and, once it
        // persists with no progress across the re-drives, alert loudly while staying queued.
        const hold = await this.recoverableDriveHolds.next(entry.queueId, infraThrowSignature(error));
        if (hold.sustainedNonRecovery) {
          return this.holdInfraBlockedAfterNonRecovery(
            projectId,
            entry,
            `merge drive transient infra error is not recovering (same failure across ${hold.attempts} re-drives): ${String(error)}`,
            hold.attempts,
          );
        }
        // Release the claim so the entry stays queued, then HOLD + arm the backoff re-drive.
        await this.deps.queue.releaseClaim(entry.queueId);
        log.warn(
          "merge drive threw a transient infra error; holding + re-driving (entry stays queued)",
          { projectId, specId: entry.specId, attempt: hold.attempts },
          error,
        );
        return { holdReason: "infra_error", retryAfterMs: hold.retryAfterMs };
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
      // through the recoverable `blocked` hold path, which alerts on sustained non-recovery
      // without permanently removing the candidate.
      outcome = { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }

    if (outcome.kind === "merged") {
      await this.recoverableDriveHolds.reset(entry.queueId);
      await this.deps.queue.markMerged(entry.queueId);
      // The merge stage itself emits merge.completed (it owns the real merge); the
      // coordinator does not double-emit it. The next pass (re-triggered by that
      // merge.completed on the bus) selects the next DAG head.
      return { mergedSpecId: entry.specId };
    }

    if (outcome.kind === "needs_attention") {
      await this.recoverableDriveHolds.reset(entry.queueId);
      // The LOUD TERMINAL ESCALATION (§2c — non-bricking): the resolver judged this spec
      // GENUINELY irreconcilable. PARK it at `needs_attention` (frees its slot — the rest
      // of the DAG keeps moving) FIRST, then dequeue `needs_attention` (the entry leaves
      // the ready set, NEVER re-queued). NOT routed through the recoverable `conflict`
      // path — re-executing it would just re-conflict forever. The escalator emits the
      // loud `dag.spec.needs_attention`; the dequeue emits `merge.dequeued`.
      if (outcome.parking === "required") {
        await this.deps.escalator.escalate({ projectId, entry, message: outcome.message });
      }
      await markDequeuedAfterEvent({
        queue: this.deps.queue,
        events: this.deps.events,
        projectId,
        entry,
        reason: "needs_attention",
        message: outcome.message,
        tx: this.deps.tx,
      });
      return { dequeuedSpecId: entry.specId };
    }

    if (outcome.kind === "re_gate_pending") {
      // THE NON-BRICKING RE-GATE HOLD: the post-auto-rebase native gate is NOT YET TERMINAL
      // (still running / infra blip). RELEASE the claim so the entry STAYS QUEUED, then arm a
      // paced re-drive — the gate just needs to finish, so the next drive re-runs it and lands
      // the merge once it reaches a terminal verdict. This NEVER dequeues (the old `conflict`
      // mapping bricked the live DAG) and has NO fixed attempt cap (a still-running gate is not
      // "non-convergence" — a human would say "wait for it"). A genuinely-stuck gate surfaces
      // via the thrown-infra halts / a terminal failed/needs_attention verdict, not a count.
      await this.recoverableDriveHolds.reset(entry.queueId);
      await this.deps.queue.releaseClaim(entry.queueId);
      log.warn("native re-gate not yet terminal after auto-rebase; holding + re-driving (entry stays queued)", {
        projectId,
        specId: entry.specId,
        retryAfterMs: RE_GATE_PENDING_RETRY_AFTER_MS,
        message: outcome.message,
      });
      return { holdReason: "re_gate_pending", retryAfterMs: RE_GATE_PENDING_RETRY_AFTER_MS };
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

    if (outcome.kind === "failed") {
      const message = `merge drive failed without a writer-rework router: ${outcome.message}`;
      await this.deps.escalator.escalate({ projectId, entry, message });
      await markDequeuedAfterEvent({
        queue: this.deps.queue,
        events: this.deps.events,
        projectId,
        entry,
        reason: "needs_attention",
        message,
        tx: this.deps.tx,
      });
      return { dequeuedSpecId: entry.specId };
    }

    // The remaining `conflict` carries a typed receipt proving its recovery owner.
    await this.recoverableDriveHolds.reset(entry.queueId);
    const reason = outcome.kind;
    await markDequeuedAfterEvent({
      queue: this.deps.queue,
      events: this.deps.events,
      projectId,
      entry,
      reason,
      message: outcome.message,
      tx: this.deps.tx,
    });
    return { dequeuedSpecId: entry.specId };
  }

  /**
   * GAP #2d/#2c: the LOUD operator-visible infra HALT for a genuinely non-retriable
   * condition (ambiguous merge state / missing required credential) — NOT a count/time
   * give-up. The merge state is unconfirmable after a 5xx, so auto-retry could double-merge;
   * a missing credential cannot self-heal. It dequeues the entry + emits
   * `merge.queue.infra_blocked`, and crucially returns NO `retryAfterMs` so the subscriber
   * arms no further timer. Sustained-non-recovery alerts use `holdInfraBlockedAfterNonRecovery`
   * instead and keep the candidate active.
   */
  private async haltInfraBlocked(
    projectId: string,
    entry: MergeQueueEntry,
    kind: "ceiling" | "ambiguous" | "missing_required_credential",
    message: string,
    attempts = 0,
  ): Promise<{ dequeuedSpecId: string }> {
    await this.recoverableDriveHolds.reset(entry.queueId);
    await markInfraBlockedAfterEvent({
      queue: this.deps.queue,
      events: this.deps.events,
      projectId,
      entry,
      kind,
      attempts,
      message,
      tx: this.deps.tx,
    });
    log.error("merge drive HALTED on a non-retriable infra condition; operator attention required", {
      projectId,
      specId: entry.specId,
      kind,
      attempts,
      message,
    });
    return { dequeuedSpecId: entry.specId };
  }

  /**
   * GAP #2d root fix, no-timeouts reframe: a sustained-non-recovering transient infra hold
   * is an ALERT, not a permanent queue removal. The trigger is the PROGRESS signal (the SAME
   * infra failure signature persisting across re-drives — see `RecoverableDriveHoldCeiling`),
   * not a count. Emit the observable `merge.queue.infra_blocked` ceiling signal (the persisted
   * attempt count rides along as telemetry), reset the per-entry streak, release the claim, and
   * keep autonomous re-drive alive with a longer backoff. If the event append fails, the fresh
   * `merging` claim remains active and normal lease recovery re-queues it instead of silently
   * losing the alert.
   */
  private async holdInfraBlockedAfterNonRecovery(
    projectId: string,
    entry: MergeQueueEntry,
    message: string,
    attempts: number,
  ): Promise<{ holdReason: "infra_error"; retryAfterMs: number }> {
    await this.recoverableDriveHolds.reset(entry.queueId);
    await this.deps.events.emitInfraBlocked({
      projectId,
      entry,
      kind: "ceiling",
      attempts,
      message,
    });
    await this.deps.queue.releaseClaim(entry.queueId);
    log.error("merge drive ALERTED on sustained infra non-recovery; continuing autonomous re-drive after backoff", {
      projectId,
      specId: entry.specId,
      attempts,
      message,
    });
    return { holdReason: "infra_error", retryAfterMs: TRANSIENT_DRIVE_HOLD_ALERT_RETRY_AFTER_MS };
  }
}
