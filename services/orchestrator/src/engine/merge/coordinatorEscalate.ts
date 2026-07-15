// NON-BRICKING conflict-escalation seam for the native merge queue
// (autonomy-engine.md §2c). Settlement routes genuine irreconcilables HERE.
// SpecEscalator.escalate is the SOLE atomic park via RecoveryParkWriter —
// park + ordered events + dequeue on one org-scoped transaction. Settlement
// branches on the typed RecoveryParkOutcome and never invents a dequeue.

import type pg from "pg";
import type { RecoveryParkOutcome, RecoveryParkWriter, RunStateWriter } from "../contracts/runStateWriter.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { resolveProjectOrg } from "../dag/percolationWrites.js";

/**
 * Escalator outcome. When `alreadyDequeued` is true (RecoveryParkWriter), settlement
 * must not emit a second dequeue. Recording fakes return alreadyDequeued:false so
 * settlement still retires the queue row.
 */
export type SpecEscalateOutcome =
  | { kind: "parked"; newlyParked: boolean; alreadyDequeued: boolean }
  | Extract<RecoveryParkOutcome, { kind: "parking_failed" }>;

/**
 * Sole park authority for merge-queue recovery retirement. ONE helper, ONE
 * policy — batch + any residual one-at-a-time settle path never drift.
 */
export interface SpecEscalator {
  /**
   * Atomic park of the exact active queue owner at needs_attention + ordered
   * events + dequeue. Returns RecoveryParkOutcome so callers settle truthfully.
   */
  escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<SpecEscalateOutcome>;
}

/**
 * Pg-backed escalator over RecoveryParkWriter (Direct or Http run-state writer).
 * Resolves project org system-scoped (coordinator has no ambient org).
 */
export class PgSpecEscalator implements SpecEscalator {
  constructor(
    private readonly pool: pg.Pool,
    private readonly runStateWriter: RunStateWriter & RecoveryParkWriter,
  ) {}

  async escalate(input: { projectId: string; entry: MergeQueueEntry; message: string }): Promise<SpecEscalateOutcome> {
    const orgId = await resolveProjectOrg(this.pool, input.projectId);
    if (orgId === null) {
      throw new Error(`cannot escalate spec ${input.entry.specId}: project ${input.projectId} has no org`);
    }
    const park = await this.runStateWriter.parkRecoveryAndDequeue({
      orgId,
      projectId: input.projectId,
      queueId: input.entry.queueId,
      runId: input.entry.runId,
      specId: input.entry.specId,
      message: input.message,
    });
    if (park.kind === "parked") {
      return { kind: "parked", newlyParked: park.newlyParked, alreadyDequeued: true };
    }
    return park;
  }
}
