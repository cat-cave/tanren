// The integration-lifecycle WRITE seam. Provider-facing data-plane work claims
// and settles reconciliations through this contract; only the control-plane
// implementation owns SQL against integration_reconciliations.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";

export type IntegrationReconciliationPhase =
  | "discover"
  | "authorize"
  | "select"
  | "provision"
  | "bind"
  | "observe"
  | "materialize"
  | "reconcile"
  | "teardown";

export type IntegrationReconciliationCompletion = "succeeded" | "retry_scheduled" | "fixed_point" | "needs_attention";

export interface ClaimIntegrationReconciliationInput {
  orgId: string;
  reconciliationId: string;
  claimOwner: string;
  leaseMs: number;
}

export interface ClaimedIntegrationReconciliation {
  projectId: string;
  requirementId: string;
  phase: IntegrationReconciliationPhase;
  attempt: number;
}

export interface HeartbeatIntegrationReconciliationInput extends ClaimIntegrationReconciliationInput {}

export interface CompleteIntegrationReconciliationInput {
  orgId: string;
  reconciliationId: string;
  claimOwner: string;
  status: IntegrationReconciliationCompletion;
  retryAfterMs?: number;
  progressSignature?: string;
  failureClassification?: string;
  compensationState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
}

export interface MarkIntegrationReconciliationStateUnknownInput {
  orgId: string;
  reconciliationId: string;
  claimOwner: string;
  failureClassification: string;
  compensationState?: Record<string, unknown>;
  observedState?: Record<string, unknown>;
}

/**
 * The sole lifecycle-state write surface for integration reconciliations.
 * `heartbeat` has no event because the frozen vocabulary deliberately contains
 * transition events only; it does not contain a heartbeat event name.
 */
export interface IntegrationStateWriter {
  claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined>;
  heartbeat(input: HeartbeatIntegrationReconciliationInput): Promise<boolean>;
  complete(input: CompleteIntegrationReconciliationInput): Promise<boolean>;
  stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean>;
}

type TransitionRow = ClaimedIntegrationReconciliation;

/**
 * In-process control-plane implementation. It performs each transition and its
 * frozen lifecycle event in one org-scoped transaction. A future remote writer
 * can implement this same contract without exposing table SQL to the data plane.
 */
export class DirectIntegrationStateWriter implements IntegrationStateWriter {
  constructor(private readonly pool: pg.Pool) {}

  async claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined> {
    assertLease(input.leaseMs);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<TransitionRow>(
        `UPDATE integration_reconciliations
         SET status = 'claimed', claim_owner = $3,
             claim_expires_at = now() + ($4 * interval '1 millisecond'),
             retry_after = NULL, attempt = attempt + 1, updated_at = now()
         WHERE org_id = $1 AND id = $2
           AND ((status IN ('pending', 'retry_scheduled') AND (retry_after IS NULL OR retry_after <= now()))
             OR (status = 'claimed' AND claim_expires_at <= now()))
         RETURNING project_id AS "projectId", requirement_id AS "requirementId", phase, attempt`,
        [input.orgId, input.reconciliationId, input.claimOwner, input.leaseMs],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        await this.appendTransition(client, input.orgId, input.reconciliationId, row, "integration.reconcile.started");
      }
      return row;
    });
  }

  async heartbeat(input: HeartbeatIntegrationReconciliationInput): Promise<boolean> {
    assertLease(input.leaseMs);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query(
        `UPDATE integration_reconciliations
         SET claim_expires_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = 'claimed' AND claim_owner = $3
           AND claim_expires_at > now()`,
        [input.orgId, input.reconciliationId, input.claimOwner, input.leaseMs],
      );
      return result.rowCount === 1;
    });
  }

  async complete(input: CompleteIntegrationReconciliationInput): Promise<boolean> {
    assertCompletion(input);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<TransitionRow>(
        `UPDATE integration_reconciliations
         SET status = $4, claim_owner = NULL, claim_expires_at = NULL,
             retry_after = CASE WHEN $5::integer IS NULL THEN NULL ELSE now() + ($5 * interval '1 millisecond') END,
             progress_signature = COALESCE($6, progress_signature), failure_classification = $7,
             compensation_state = COALESCE($8::jsonb, compensation_state),
             observed_state = COALESCE($9::jsonb, observed_state), updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = 'claimed' AND claim_owner = $3
           AND claim_expires_at > now()
         RETURNING project_id AS "projectId", requirement_id AS "requirementId", phase, attempt`,
        [
          input.orgId,
          input.reconciliationId,
          input.claimOwner,
          input.status,
          input.retryAfterMs ?? null,
          input.progressSignature ?? null,
          input.failureClassification ?? null,
          input.compensationState === undefined ? null : JSON.stringify(input.compensationState),
          input.observedState === undefined ? null : JSON.stringify(input.observedState),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return false;
      const eventType = completionEventType(input.status);
      if (eventType !== undefined) {
        await this.appendTransition(client, input.orgId, input.reconciliationId, row, eventType);
      }
      return true;
    });
  }

  async stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<TransitionRow>(
        `UPDATE integration_reconciliations
         SET status = 'state_unknown', claim_owner = NULL, claim_expires_at = NULL,
             failure_classification = $4,
             compensation_state = COALESCE($5::jsonb, compensation_state),
             observed_state = COALESCE($6::jsonb, observed_state), updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = 'claimed' AND claim_owner = $3
           AND claim_expires_at > now()
         RETURNING project_id AS "projectId", requirement_id AS "requirementId", phase, attempt`,
        [
          input.orgId,
          input.reconciliationId,
          input.claimOwner,
          input.failureClassification,
          input.compensationState === undefined ? null : JSON.stringify(input.compensationState),
          input.observedState === undefined ? null : JSON.stringify(input.observedState),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return false;
      await this.appendTransition(
        client,
        input.orgId,
        input.reconciliationId,
        row,
        "integration.reconcile.state_unknown",
      );
      return true;
    });
  }

  private async appendTransition(
    client: pg.PoolClient,
    orgId: string,
    reconciliationId: string,
    row: TransitionRow,
    eventType:
      | "integration.reconcile.started"
      | "integration.reconcile.retry_scheduled"
      | "integration.reconcile.fixed_point"
      | "integration.reconcile.state_unknown",
  ): Promise<void> {
    await new PgEventStore(client).append({
      orgId,
      projectId: row.projectId,
      eventType,
      payload: {
        reconciliationId,
        requirementId: row.requirementId,
        phase: row.phase,
        attempt: row.attempt,
      },
    });
  }
}

function assertLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("integration reconciliation leaseMs must be a positive safe integer");
  }
}

function assertCompletion(input: CompleteIntegrationReconciliationInput): void {
  const hasRetry = input.retryAfterMs !== undefined;
  if (input.status === "retry_scheduled" && !hasRetry) {
    throw new Error("retry_scheduled integration reconciliation completion requires retryAfterMs");
  }
  if (input.status !== "retry_scheduled" && hasRetry) {
    throw new Error("only retry_scheduled integration reconciliation completion accepts retryAfterMs");
  }
  if (hasRetry) assertLease(input.retryAfterMs!);
}

function completionEventType(
  status: IntegrationReconciliationCompletion,
): "integration.reconcile.retry_scheduled" | "integration.reconcile.fixed_point" | undefined {
  if (status === "retry_scheduled") return "integration.reconcile.retry_scheduled";
  return status === "fixed_point" ? "integration.reconcile.fixed_point" : undefined;
}
