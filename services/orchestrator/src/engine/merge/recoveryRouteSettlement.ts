// Sole settlement adapter for typed conflict recovery. Routers only decide
// owned|parking_required|terminal_noop|parking_failed; this adapter is the ONE
// consumer allowed to turn parking_required into a durable park. It resolves the
// exact active merge-queue identity system-scoped, then delegates the mutation to
// RecoveryParkWriter (atomic needs_attention + ordered events + dequeue).

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ConflictRecoveryDisposition, ConflictRecoverySettlement } from "../contracts/conflictResolution.js";
import type { RecoveryParkWriter, RunStateWriter } from "../contracts/runStateWriter.js";
import { recoverableRetryDelayMs } from "./retrySchedule.js";

export type RecoveryCapableRunStateWriter = RunStateWriter & RecoveryParkWriter;

/** Honest runtime guard: production direct/HTTP writers implement both ports. */
export function isRecoveryParkWriter(writer: RunStateWriter): writer is RecoveryCapableRunStateWriter {
  return (
    writer !== undefined &&
    writer !== null &&
    "parkRecoveryAndDequeue" in writer &&
    typeof (writer as { parkRecoveryAndDequeue?: unknown }).parkRecoveryAndDequeue === "function"
  );
}

/** Fail loud at assembly rather than silently installing a non-parking consumer. */
export function requireRecoveryParkWriter(writer: RunStateWriter): RecoveryCapableRunStateWriter {
  if (!isRecoveryParkWriter(writer)) {
    throw new Error("recovery settlement requires RunStateWriter & RecoveryParkWriter");
  }
  return writer;
}

export interface RecoveryRouteSettler {
  settle(input: {
    projectId: string;
    runId: string;
    specId: string;
    recovery: ConflictRecoveryDisposition;
  }): Promise<ConflictRecoverySettlement>;
}

interface ActiveRecoveryTarget {
  queueId: string;
  orgId: string;
}

const RETRY_AFTER_MS = recoverableRetryDelayMs(1);

/**
 * Production typed-recovery settler. The read only discovers an exact candidate;
 * RecoveryParkWriter independently locks and re-verifies the full tuple before
 * any mutation, so a lookup race fails closed rather than granting a receipt.
 */
export class PgRecoveryRouteSettler implements RecoveryRouteSettler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly writer: RecoveryCapableRunStateWriter,
  ) {}

  async settle(input: {
    projectId: string;
    runId: string;
    specId: string;
    recovery: ConflictRecoveryDisposition;
  }): Promise<ConflictRecoverySettlement> {
    if (input.recovery.kind === "owned" || input.recovery.kind === "terminal_noop") {
      return input.recovery;
    }
    if (input.recovery.kind === "parking_failed") {
      return {
        kind: "parking_failed",
        message: input.recovery.message,
        queueDisposition: "unknown",
        retryAfterMs: RETRY_AFTER_MS,
      };
    }

    const target = await this.loadActiveTarget(input);
    if (target === undefined) {
      return {
        kind: "parking_failed",
        message:
          `${input.recovery.message} (atomic park could not resolve an exact active ` +
          `queue owner for project=${input.projectId} run=${input.runId} spec=${input.specId})`,
        queueDisposition: "unknown",
        retryAfterMs: RETRY_AFTER_MS,
      };
    }
    const parked = await this.writer.parkRecoveryAndDequeue({
      orgId: target.orgId,
      projectId: input.projectId,
      queueId: target.queueId,
      runId: input.runId,
      specId: input.specId,
      message: input.recovery.message,
    });
    if (parked.kind === "parked") {
      return parked;
    }
    return {
      kind: "parking_failed",
      message: `${input.recovery.message} (atomic park failed: ${parked.reason})`,
      queueDisposition: parked.queueDisposition,
      retryAfterMs: parked.retryAfterMs,
    };
  }

  private async loadActiveTarget(input: {
    projectId: string;
    runId: string;
    specId: string;
  }): Promise<ActiveRecoveryTarget | undefined> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ queue_id: string; org_id: string }>(
        `SELECT queue_id, org_id
           FROM merge_queue
          WHERE project_id = $1
            AND run_id = $2
            AND spec_id = $3
            AND status IN ('queued', 'merging')
          LIMIT 1`,
        [input.projectId, input.runId, input.specId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { queueId: row.queue_id, orgId: row.org_id };
    });
  }
}
