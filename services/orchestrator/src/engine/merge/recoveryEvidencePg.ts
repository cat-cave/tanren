// Production RecoveryEvidencePort: settlement-time readback over runs (+ tasks)
// under system/BYPASSRLS scope (runWithSystemScope). Unscoped app-pool reads see
// zero rows under RLS and would always fail readback — never raw-query the tenant pool.
// Fail-closed: every no-evidence branch returns undefined explicitly.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import {
  hasStructuralOwnedReceiptShape,
  isActiveOwnerRunStatus,
  type RecoveryEvidencePort,
  type RecoveryRunEvidence,
} from "./recoveryOwnership.js";

export class PgRecoveryEvidencePort implements RecoveryEvidencePort {
  constructor(private readonly pool: pg.Pool) {}

  async verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) {
      return undefined;
    }
    return runWithSystemScope(this.pool, async (client): Promise<RecoveryRunEvidence | undefined> => {
      if (input.receipt.run.kind === "already_running") {
        return this.verifyRun(client, input.receipt.run.runId, input.expectedSpecId);
      }
      const run = await this.verifyRun(client, input.receipt.run.replanRunId, input.expectedSpecId);
      if (run === undefined) {
        return undefined;
      }
      const taskOk = await this.taskBelongsToRun(
        client,
        input.receipt.run.plannerTaskId,
        input.receipt.run.replanRunId,
      );
      if (!taskOk) {
        return undefined;
      }
      return { ...run, plannerTaskId: input.receipt.run.plannerTaskId };
    });
  }

  private async verifyRun(
    client: pg.PoolClient,
    runId: string,
    expectedSpecId: string,
  ): Promise<RecoveryRunEvidence | undefined> {
    const result = await client.query<{ run_id: string; spec_id: string; status: string }>(
      `SELECT run_id, spec_id, status FROM runs WHERE run_id = $1 LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined || row.spec_id !== expectedSpecId || !isActiveOwnerRunStatus(row.status)) {
      return undefined;
    }
    return { runId: row.run_id, specId: row.spec_id, runStatus: row.status };
  }

  private async taskBelongsToRun(client: pg.PoolClient, plannerTaskId: string, runId: string): Promise<boolean> {
    const result = await client.query<{ task_id: string }>(
      `SELECT task_id FROM tasks WHERE task_id = $1 AND run_id = $2 LIMIT 1`,
      [plannerTaskId, runId],
    );
    return result.rows[0] !== undefined;
  }
}
