// Production RecoveryEvidencePort: settlement-time readback over runs (+ tasks for
// enqueued receipts). Proves the named run belongs to the exact recovery spec and is
// currently in an active owner status (queued/running/paused). Fail closed on any miss.

import type pg from "pg";
import type { ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  type RecoveryEvidencePort,
  type RecoveryRunEvidence,
} from "./recoveryOwnership.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export class PgRecoveryEvidencePort implements RecoveryEvidencePort {
  constructor(private readonly client: QueryClient) {}

  async verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) {
      return undefined;
    }
    if (input.receipt.run.kind === "already_running") {
      return this.verifyRun(input.receipt.run.runId, input.expectedSpecId);
    }
    // enqueued: prove replanRunId is an active owner run for the exact spec + task binds to it
    const run = await this.verifyRun(input.receipt.run.replanRunId, input.expectedSpecId);
    if (run === undefined) return undefined;
    const taskOk = await this.taskBelongsToRun(input.receipt.run.plannerTaskId, input.receipt.run.replanRunId);
    if (!taskOk) return undefined;
    return { ...run, plannerTaskId: input.receipt.run.plannerTaskId };
  }

  private async verifyRun(runId: string, expectedSpecId: string): Promise<RecoveryRunEvidence | undefined> {
    const result = await this.client.query<{ run_id: string; spec_id: string; status: string }>(
      `SELECT run_id, spec_id, status FROM runs WHERE run_id = $1 LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (row.spec_id !== expectedSpecId) return undefined;
    if (!isActiveOwnerRunStatus(row.status)) return undefined;
    return { runId: row.run_id, specId: row.spec_id, runStatus: row.status };
  }

  private async taskBelongsToRun(plannerTaskId: string, runId: string): Promise<boolean> {
    const result = await this.client.query<{ task_id: string }>(
      `SELECT task_id FROM tasks WHERE task_id = $1 AND run_id = $2 LIMIT 1`,
      [plannerTaskId, runId],
    );
    return result.rows[0] !== undefined;
  }
}
