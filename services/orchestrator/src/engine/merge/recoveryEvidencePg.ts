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

type RecoveryEvidenceClient = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

/**
 * Exact receipt readback on a caller-owned transaction. `lockOwner` is used by
 * the atomic dequeue authority so the successor cannot halt between proof and
 * retirement. The standalone port leaves locking to that authority.
 */
export async function readOwnedReceiptEvidence(
  client: RecoveryEvidenceClient,
  input: {
    expectedOrgId: string;
    expectedProjectId: string;
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  },
  lockOwner = false,
): Promise<RecoveryRunEvidence | undefined> {
  if (!hasStructuralOwnedReceiptShape(input.receipt, input.expectedSpecId)) return undefined;
  const runId = input.receipt.run.kind === "enqueued" ? input.receipt.run.replanRunId : input.receipt.run.runId;
  const runResult = await client.query<{
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
      LIMIT 1${lockOwner ? " FOR UPDATE" : ""}`,
    [runId, input.expectedOrgId, input.expectedProjectId, input.expectedSpecId],
  );
  const row = runResult.rows[0];
  if (row === undefined || !isActiveOwnerRunStatus(row.status)) return undefined;
  const run: RecoveryRunEvidence = {
    orgId: row.org_id,
    projectId: row.project_id,
    runId: row.run_id,
    specId: row.spec_id,
    runStatus: row.status,
  };
  if (input.receipt.run.kind === "already_running") return run;

  const taskResult = await client.query<{ task_id: string; kind: string }>(
    `SELECT task_id, kind
       FROM tasks
      WHERE task_id = $1
        AND run_id = $2
        AND org_id = $3
        AND kind = 'plan'
      LIMIT 1${lockOwner ? " FOR SHARE" : ""}`,
    [input.receipt.run.plannerTaskId, input.receipt.run.replanRunId, input.expectedOrgId],
  );
  const task = taskResult.rows[0];
  if (task === undefined) return undefined;
  return { ...run, plannerTaskId: task.task_id, plannerTaskKind: task.kind };
}

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
    return runWithSystemScope(this.pool, (client) => readOwnedReceiptEvidence(client, input));
  }
}
