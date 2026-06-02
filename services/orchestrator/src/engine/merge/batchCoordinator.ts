// The production BatchMergeCoordinator (autonomy-engine.md §2d — speculative
// batch-check + bisect, the P2d-2 intelligence layer over the P2d-1 native queue).
// It is a SCHEDULER over the EXISTING per-run merge path (the SAME P2d-1 MergeRunner /
// MergeQueueModel), NOT a second merge implementation — it adds a speculative
// validation step BEFORE the real merges:
//
// Each pass (`coordinate(projectId)`):
//   1. recover stale claims (P2d-1 crash recovery — lease) → load the queue snapshot
//      under RLS,
//   2. FORM a batch (the DAG-ordered, mutually-eligible prefix; capped + logged),
//   3. BATCH-CHECK the prospective merged state (`default_branch + batch PRs` via the
//      BatchChecker — reuses the P2c-1 SpeculativeIntegrator + the VcsProvider CI seam),
//      emitting merge.batch.checking,
//   4. on PASS → drive the batch's real merges in DAG order via the P2d-1 path (one at
//      a time — serialization holds), emitting merge.batch.passed,
//   5. on FAIL/CONFLICT → BISECT (binary-search the batch) to isolate the single
//      offending PR, DEQUEUE it to a recoverable outcome (routed to re-execution, NOT
//      dropped), emit merge.batch.bisecting + merge.batch.culprit, and RE-FORM +
//      RE-CHECK the batch WITHOUT it so the innocent PRs still merge.
//
// INVARIANTS (mirroring the spec): a batch whose check fails NEVER merges to
// default_branch (only a passing prospective state's entries are driven); ordering
// (ancestor-before-dependent) is preserved within + across batches; the culprit's
// work is preserved (recoverable dequeue, never discarded); no innocent PR is dropped;
// bisect terminates (each step shrinks the suspect set); a crash mid-batch leaves the
// queue recoverable (the P2d-1 lease/recovery, reused unchanged).

import {
  type BatchCheckVerdict,
  type BatchChecker,
  type BatchFormation,
  bisectCulprit,
  DEFAULT_MAX_BATCH_SIZE,
  formBatch,
} from "../contracts/batchMergeCoordinator.js";
import {
  type CoordinateResult,
  type MergeCoordinator,
  type MergeDriveOutcome,
  type MergeQueueEntry,
  type MergeQueueModel,
  type MergeRunner,
} from "../contracts/mergeCoordinator.js";
import type { MergeQueueEventEmitter } from "./coordinator.js";

/**
 * Thrown by the bisect callback when a sub-batch's CI is still pending — bisect
 * cannot give a definitive verdict, so the pass aborts the bisect + HOLDS (it never
 * guesses, which could blame an innocent PR). The next CI-completion re-triggers.
 */
class BatchCheckStillPendingError extends Error {}

/** The batch-level events the coordinator emits (the P2d-2 visibility surface). */
export interface BatchMergeEventEmitter {
  /** merge.batch.checking: a batch was formed + is being speculatively integrated + checked. */
  emitChecking(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    formation: BatchFormation;
    maxBatchSize: number;
  }): Promise<void>;
  /** merge.batch.passed: the batch check is green; the entries will merge in DAG order. */
  emitPassed(input: {
    projectId: string;
    batch: ReadonlyArray<MergeQueueEntry>;
    integrationBranch: string;
  }): Promise<void>;
  /** merge.batch.bisecting: the batch check failed; the coordinator is isolating the culprit. */
  emitBisecting(input: { projectId: string; batch: ReadonlyArray<MergeQueueEntry>; message: string }): Promise<void>;
  /** merge.batch.culprit: bisect isolated the single offending PR (dequeued, recoverable). */
  emitCulprit(input: { projectId: string; culprit: MergeQueueEntry; checks: number; message: string }): Promise<void>;
}

export interface BatchMergeCoordinatorDeps {
  queue: MergeQueueModel;
  runner: MergeRunner;
  checker: BatchChecker;
  /** The base queue-event emitter (merge.queue.advanced / merge.dequeued — reused). */
  events: MergeQueueEventEmitter;
  /** The batch-level event emitter (merge.batch.*). */
  batchEvents: BatchMergeEventEmitter;
  /**
   * Resolve the per-project max batch size (the config knob). Defaults to a constant
   * `DEFAULT_MAX_BATCH_SIZE` resolver when omitted (tests inject a fixed value). The
   * production assembly resolves `projects.config.maxBatchSize` under RLS.
   */
  resolveMaxBatchSize?: (projectId: string) => Promise<number>;
}

/**
 * The production BatchMergeCoordinator. Adds the speculative batch-check + bisect on
 * top of the P2d-1 one-at-a-time drive. It reloads the queue every pass (DAG state is
 * the source of truth, never cached). It performs the REAL merges through the SAME
 * P2d-1 runner/model, so the P2d-1 ordering + serialization + lease/recovery guarantees
 * hold unchanged; the only addition is that the batch is PROVEN green as a combined
 * unit before any of it merges, and a bad interaction is isolated to one PR via bisect.
 */
export class BatchMergeCoordinator implements MergeCoordinator {
  private readonly resolveMaxBatchSize: (projectId: string) => Promise<number>;

  constructor(private readonly deps: BatchMergeCoordinatorDeps) {
    this.resolveMaxBatchSize = deps.resolveMaxBatchSize ?? (() => Promise.resolve(DEFAULT_MAX_BATCH_SIZE));
  }

  async coordinate(projectId: string): Promise<CoordinateResult> {
    // P2d-1 crash recovery FIRST: a coordinator that died mid-merge left a stale
    // `merging` claim; return it to `queued` (the merge is idempotent) so this pass
    // re-considers it. The lease (recoverStaleClaims) is the SAME P2d-1 mechanism.
    await this.deps.queue.recoverStaleClaims(projectId);

    const maxBatchSize = await this.resolveMaxBatchSize(projectId);
    const snapshot = await this.deps.queue.loadSnapshot(projectId);
    const queueDepth = snapshot.entries.length;

    // Form the batch from the CURRENT snapshot (a merge already in flight ⇒ empty
    // batch: the P2d-1 serialization lock dominates and we hold this pass).
    const formation = formBatch(snapshot, maxBatchSize);
    if (formation.batch.length === 0) {
      const holdReason = snapshot.mergingInFlight
        ? "serialized"
        : snapshot.entries.length === 0
          ? "empty"
          : "all_blocked";
      return { projectId, holdReason, queueDepth };
    }

    // Run the batch through check → (pass: merge all | fail: bisect + re-check). The
    // recursion re-forms the batch WITHOUT the culprit each fail, so the innocent PRs
    // still merge; it terminates because each bisect strictly removes one entry.
    return this.processBatch(projectId, formation, queueDepth, maxBatchSize);
  }

  /**
   * Speculatively check the formed batch, then either drive every entry's real merge
   * (on pass) or isolate + dequeue the offending PR and re-check the remainder (on
   * fail). `formation` is the already-formed batch for THIS attempt; on a fail we
   * re-FORM (reload the snapshot) without the culprit so a newly-eligible entry can
   * join and the cap is re-applied. Bounded: each fail removes exactly one entry, so
   * the loop runs at most `batch.length` times.
   */
  private async processBatch(
    projectId: string,
    formation: BatchFormation,
    queueDepth: number,
    maxBatchSize: number,
  ): Promise<CoordinateResult> {
    let current = formation;
    // Specs already bisected-out this pass — excluded from the re-formed batch so a
    // re-form never re-includes a known culprit (the loop strictly shrinks).
    const excludedSpecIds = new Set<string>();

    // The loop bound: at most one entry is removed per iteration, so it cannot exceed
    // the initial batch size + 1 (the final all-clear merge). A hard ceiling guards
    // against any logic error ever spinning.
    const maxIterations = formation.eligibleCount + 1;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (current.batch.length === 0) {
        // Everything eligible was bisected out (an all-culprits batch) — nothing to
        // merge this pass; the dequeued culprits re-enter via re-execution later.
        return { projectId, holdReason: "all_blocked", queueDepth };
      }

      if (current.capped) {
        // The cap LOG (operator visibility — never a SILENT truncation): the queue had
        // more eligible entries than the batch size; the remainder keeps its position
        // and is re-considered next pass.
        console.info(
          `[batch-coordinator] project ${projectId}: batch CAPPED to ${current.batch.length} of ${current.eligibleCount} eligible (maxBatchSize=${maxBatchSize}); the remainder is re-considered next pass`,
        );
      }
      await this.deps.batchEvents.emitChecking({
        projectId,
        batch: current.batch,
        formation: current,
        maxBatchSize,
      });

      const verdict = await this.checkEntries(projectId, current.batch);

      if (verdict.result === "pass") {
        await this.deps.batchEvents.emitPassed({
          projectId,
          batch: current.batch,
          integrationBranch: verdict.integrationBranch,
        });
        return this.mergeBatch(projectId, current.batch, queueDepth);
      }

      if (verdict.result === "pending") {
        // The prospective merged state's CI is still RUNNING — NOT a failure. HOLD
        // (do NOT bisect a not-yet-terminal batch, which could blame an innocent PR);
        // the next CI-completion notification re-triggers a fresh coordinate pass.
        return { projectId, holdReason: "all_blocked", queueDepth };
      }

      // FAIL/CONFLICT → bisect to isolate the single offending PR.
      const failMessage = verdict.result === "conflict" ? `integration conflict: ${verdict.message}` : verdict.message;
      await this.deps.batchEvents.emitBisecting({ projectId, batch: current.batch, message: failMessage });

      const bisect = await this.bisectBatch(projectId, current.batch);
      if (bisect === "pending") {
        // A sub-batch's CI was still running — HOLD (no entry dequeued/blamed); the
        // next CI-completion re-triggers a fresh pass.
        return { projectId, holdReason: "all_blocked", queueDepth };
      }

      // Dequeue the culprit to a RECOVERABLE outcome (conflict reason ⇒ routed to the
      // P2b re-execution path by the dequeue handler — the run loop re-enqueues it once
      // it re-gates clean). It is NEVER dropped/merged.
      await this.deps.queue.markDequeued(bisect.culprit.queueId, "conflict");
      await this.deps.events.emitDequeued({
        projectId,
        entry: bisect.culprit,
        reason: "conflict",
        message: `bisected as the offending PR in a failed batch check: ${failMessage}`,
      });
      await this.deps.batchEvents.emitCulprit({
        projectId,
        culprit: bisect.culprit,
        checks: bisect.checks,
        message: failMessage,
      });
      excludedSpecIds.add(bisect.culprit.specId);

      // RE-FORM the batch WITHOUT the culprit (reload the snapshot so the dequeued
      // culprit is gone + a newly-eligible entry can join + the cap re-applies), then
      // re-check the innocent remainder on the next loop iteration.
      const refreshed = await this.deps.queue.loadSnapshot(projectId);
      const reformed = formBatch(refreshed, maxBatchSize);
      reformed.batch = reformed.batch.filter((e) => !excludedSpecIds.has(e.specId));
      current = reformed;
    }

    // The loop bound was hit (a logic guard — should be unreachable since each fail
    // removes one entry). Hold rather than risk an unverified merge.
    return { projectId, holdReason: "all_blocked", queueDepth };
  }

  /**
   * Speculatively integrate + CI-check the given entry set (the BatchChecker assembles
   * `default_branch + the entries` and runs CI on the ephemeral integration ref —
   * NEVER touching default_branch). An empty set checks the base alone (which passes —
   * the bisect's lower-bound invariant). A thrown checker is treated as a `fail` so a
   * transient error never lets an unverified batch through (conservatively fails).
   */
  private async checkEntries(projectId: string, entries: ReadonlyArray<MergeQueueEntry>): Promise<BatchCheckVerdict> {
    try {
      return await this.deps.checker.checkBatch({ projectId, entries });
    } catch (error) {
      return { result: "fail", message: `batch check threw: ${String(error)}` };
    }
  }

  /**
   * Binary-search the failed batch to isolate the single offending PR (the pure
   * `bisectCulprit` driver over `checkEntries`). Returns the bisect result, or
   * `"pending"` when a sub-batch's CI was still running (the pass HOLDS rather than
   * guess — never blaming an innocent). Each sub-batch check is a speculative
   * integration + CI-check on a PREFIX of the batch; the pure driver guarantees it
   * terminates + names exactly the pass→fail boundary.
   */
  private async bisectBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
  ): Promise<Awaited<ReturnType<typeof bisectCulprit>> | "pending"> {
    try {
      return await bisectCulprit(batch, async (prefixLength) => {
        const v = await this.checkEntries(projectId, batch.slice(0, prefixLength));
        if (v.result === "pending") {
          throw new BatchCheckStillPendingError(`sub-batch CI still pending (prefix length ${prefixLength})`);
        }
        return v.result === "pass" ? "pass" : "fail";
      });
    } catch (error) {
      if (error instanceof BatchCheckStillPendingError) return "pending";
      throw error;
    }
  }

  /**
   * Drive the validated batch's REAL merges in DAG order through the P2d-1 path (the
   * SAME runner/model). Each entry is claimed (the serialization lock), driven, and
   * settled — one at a time, ancestor before dependent. A merged entry advances; a
   * conflict/blocked/failed entry on the REAL merge (a reality the speculative check
   * could not see, e.g. the live base moved) dequeues recoverably and STOPS the batch
   * (a later dependent must not merge ahead of a now-missing ancestor) — the next
   * coordinate pass re-forms + re-checks from the new reality. This NEVER merges an
   * entry the batch check did not validate.
   */
  private async mergeBatch(
    projectId: string,
    batch: ReadonlyArray<MergeQueueEntry>,
    queueDepth: number,
  ): Promise<CoordinateResult> {
    let mergedSpecId: string | undefined;
    let dequeuedSpecId: string | undefined;
    for (const entry of batch) {
      const claimed = await this.deps.queue.claim(entry.queueId);
      if (!claimed) {
        // Another pass already claimed it (serialization) — stop; the winning pass
        // drives it. The next trigger re-coordinates.
        break;
      }
      await this.deps.events.emitAdvanced({ projectId, entry, queueDepth });

      const outcome = await this.driveOne(projectId, entry);
      if (outcome.kind === "merged") {
        await this.deps.queue.markMerged(entry.queueId);
        mergedSpecId = entry.specId;
        continue;
      }

      // A real-merge conflict/blocked/failed: dequeue recoverably + STOP the batch so
      // no dependent merges ahead of a now-absent ancestor. The next pass re-checks.
      const reason = outcome.kind;
      await this.deps.queue.markDequeued(entry.queueId, reason);
      await this.deps.events.emitDequeued({ projectId, entry, reason, message: outcome.message });
      dequeuedSpecId = entry.specId;
      break;
    }
    return {
      projectId,
      queueDepth,
      ...(mergedSpecId !== undefined && { mergedSpecId }),
      ...(dequeuedSpecId !== undefined && { dequeuedSpecId }),
    };
  }

  /** Drive ONE entry's real merge through the P2d-1 path; a thrown drive ⇒ recoverable blocked. */
  private async driveOne(projectId: string, entry: MergeQueueEntry): Promise<MergeDriveOutcome> {
    try {
      return await this.deps.runner.driveMerge({ runId: entry.runId, projectId });
    } catch (error) {
      return { kind: "blocked", message: `merge drive threw: ${String(error)}` };
    }
  }
}
