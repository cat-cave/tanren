// in-11 — the reconciliation queue read seam.
//
// The saga's DB reads (which claimable rows exist, the just-claimed row's durable
// inputs, the derived capability-node advance, the project→org resolution) sit behind
// this contract so the saga's orchestration is testable without a database and a
// future remote reader can implement it without exposing table SQL. The production
// impl (`PgReconciliationClaimSource`) runs every tenant read org-scoped; RLS denies
// by default, so an off-scope read sees ZERO rows.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";

/** The durable reconcile inputs read after a claim — the saga's resume state. */
export interface ClaimedReconciliationRow {
  readonly projectId: string;
  readonly requirementId: string;
  readonly phase: string;
  readonly attempt: number;
  readonly requestFingerprint: string;
  readonly bindingId: string | null;
  readonly bindingGeneration: number | null;
  readonly compensationState: unknown;
}

export interface ReconciliationClaimSource {
  /** Claimable reconciliation ids for a project (pending/retry-due, or expired claim). */
  selectClaimable(orgId: string, projectId: string): Promise<string[]>;
  /** The just-claimed row's durable inputs (undefined if it vanished). */
  readClaimed(orgId: string, reconciliationId: string): Promise<ClaimedReconciliationRow | undefined>;
  /** Advance every `enqueued` capability node whose reconciliation reached `fixed_point`. */
  settleReadyCapabilityNodes(orgId: string, projectId: string): Promise<number>;
  /** Resolve a project's org (system scope); throw LOUDLY if it has none. */
  resolveOrgOrThrow(projectId: string): Promise<string>;
}

interface ClaimableRow {
  id: string;
}

interface ClaimedRow {
  project_id: string;
  requirement_id: string;
  phase: string;
  attempt: number;
  request_fingerprint: string;
  binding_id: string | null;
  binding_generation: number | null;
  compensation_state: unknown;
}

/** The production pg-backed reconciliation read seam. */
export class PgReconciliationClaimSource implements ReconciliationClaimSource {
  constructor(private readonly pool: pg.Pool) {}

  async selectClaimable(orgId: string, projectId: string): Promise<string[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<ClaimableRow>(
        `SELECT id
           FROM integration_reconciliations
          WHERE org_id = $1 AND project_id = $2
            AND ((status IN ('pending', 'retry_scheduled') AND (retry_after IS NULL OR retry_after <= now()))
              OR (status = 'claimed' AND claim_expires_at <= now()))
          ORDER BY id`,
        [orgId, projectId],
      );
      return result.rows.map((r) => r.id);
    });
  }

  async readClaimed(orgId: string, reconciliationId: string): Promise<ClaimedReconciliationRow | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<ClaimedRow>(
        `SELECT project_id, requirement_id, phase, attempt, request_fingerprint,
                binding_id, binding_generation, compensation_state
           FROM integration_reconciliations
          WHERE org_id = $1 AND id = $2`,
        [orgId, reconciliationId],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            projectId: row.project_id,
            requirementId: row.requirement_id,
            phase: row.phase,
            attempt: row.attempt,
            requestFingerprint: row.request_fingerprint,
            bindingId: row.binding_id,
            bindingGeneration: row.binding_generation,
            compensationState: row.compensation_state,
          };
    });
  }

  async settleReadyCapabilityNodes(orgId: string, projectId: string): Promise<number> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query(
        `UPDATE capability_nodes cn
            SET status = 'ready', wait_reason = NULL, updated_at = now()
          WHERE cn.org_id = $1 AND cn.project_id = $2 AND cn.status = 'enqueued'
            AND EXISTS (
              SELECT 1 FROM integration_reconciliations r
               WHERE r.org_id = cn.org_id AND r.project_id = cn.project_id
                 AND r.requirement_id = cn.requirement_id
                 AND r.request_fingerprint = cn.desired_state_hash
                 AND r.status = 'fixed_point')`,
        [orgId, projectId],
      );
      return result.rowCount ?? 0;
    });
  }

  async resolveOrgOrThrow(projectId: string): Promise<string> {
    const orgId = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) {
      throw new Error(`project ${projectId} has no org for reconciliation saga`);
    }
    return orgId;
  }
}
