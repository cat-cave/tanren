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
    expectedOrgId: string;
    expectedProjectId: string;
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined> {
    if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) {
      return undefined;
    }
    return runWithSystemScope(this.pool, async (client): Promise<RecoveryRunEvidence | undefined> => {
      if (input.receipt.run.kind === "already_running") {
        return this.verifyRun(client, input.receipt.run.runId, input);
      }
      const run = await this.verifyRun(client, input.receipt.run.replanRunId, input);
      if (run === undefined) {
        return undefined;
      }
      const taskOk = await this.taskBelongsToRun(
        client,
        input.receipt.run.plannerTaskId,
        input.receipt.run.replanRunId,
        input.expectedOrgId,
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
    expected: { expectedOrgId: string; expectedProjectId: string; expectedSpecId: string },
  ): Promise<RecoveryRunEvidence | undefined> {
    const result = await client.query<{
      org_id: string;
      project_id: string;
      run_id: string;
      spec_id: string;
      status: string;
    }>(
      `SELECT org_id, project_id, run_id, spec_id, status
         FROM runs
        WHERE run_id = $1
          AND org_id = $2
          AND project_id = $3
          AND spec_id = $4
        LIMIT 1`,
      [runId, expected.expectedOrgId, expected.expectedProjectId, expected.expectedSpecId],
    );
    const row = result.rows[0];
    if (row === undefined || !isActiveOwnerRunStatus(row.status)) {
      return undefined;
    }
    return {
      orgId: row.org_id,
      projectId: row.project_id,
      runId: row.run_id,
      specId: row.spec_id,
      runStatus: row.status,
    };
  }

  /**
   * Enqueued proof binds task id + run id + canonical planner task kind (`plan`).
   * A write/check/etc. task on the same run must NOT satisfy plannerTaskId.
   */
  private async taskBelongsToRun(
    client: pg.PoolClient,
    plannerTaskId: string,
    runId: string,
    expectedOrgId: string,
  ): Promise<boolean> {
    const result = await client.query<{ task_id: string }>(
      `SELECT task_id
         FROM tasks
        WHERE task_id = $1
          AND run_id = $2
          AND org_id = $3
          AND kind = 'plan'
        LIMIT 1`,
      [plannerTaskId, runId, expectedOrgId],
    );
    return result.rows[0] !== undefined;
  }
}
