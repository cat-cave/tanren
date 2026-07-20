// The durable substrate for the resumable delivery DAG: an ORG-SCOPED store over the
// migration-0043 `delivery_runs` + `delivery_stage_attempts` tables. Every read and
// write runs through `runWithOrgScope`, so RLS denies cross-tenant rows by default (a
// query off the scoped client sees ZERO rows of another org).
//
// FENCE DISCIPLINE (modeled on the in-11 reconciliation saga's claim fence): the claim
// stamps a fresh per-claim FENCING TOKEN into `claim_owner`; EVERY subsequent write —
// each stage-attempt start/succeed/degrade AND every run terminal-mark — is CAS-guarded
// `WHERE claim_owner = $token AND status = 'running'` and returns a BOOLEAN from the
// affected-row count. A superseded owner (a newer claim overwrote the token) therefore
// has all of its writes REJECTED (0 rows), so a stale driver can never overwrite the live
// owner's settle — completed can never be flipped to degraded, and vice versa.
//
// NO WALL-CLOCK: the fence is the TOKEN, not a timer. `claim_expires_at` is set to a
// non-expiring `'infinity'` sentinel purely to satisfy the 0043 both-or-neither claim
// constraint; takeover is a token OVERWRITE (any non-`completed` run is re-claimable),
// never a fixed-millisecond expiry, so correctness never depends on a clock (timeout /
// retry-cap eradication doctrine).

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { DELIVERY_STAGES, stageOrdinal, type DeliveryRunStatus, type DeliveryStage } from "./stageModel.js";

/** A delivery run the driver has claimed for this pass, with its live fencing token. */
export interface ClaimedDeliveryRun {
  readonly id: string;
  readonly projectId: string;
  readonly mergeSha: string;
  readonly authorityDecisionId: string;
  /** The fencing token this drive holds — every write is CAS-guarded on it. */
  readonly token: string;
}

/** The durable progress of one stage across attempts. */
export interface StageProgress {
  readonly succeeded: boolean;
  readonly attemptsSoFar: number;
}

function affectedOne(result: pg.QueryResult): boolean {
  return (result.rowCount ?? 0) >= 1;
}

export class DeliveryRunStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * CLAIM the delivery outbox row for a merged run, keyed on `(project, merge_sha)`, by
   * OVERWRITING `claim_owner` with a fresh fencing token and bumping status to `running`.
   * Any non-`completed` row is claimable (pending / degraded / needs_attention / a running
   * row a crashed or superseded owner left) — a new claim always supersedes; the old
   * token's writes then fail their CAS. A `completed` row is terminal and never re-claimed.
   * Returns the claimed row + its fencing token, or `undefined` (already completed / no
   * outbox row for this merge).
   */
  async claim(orgId: string, projectId: string, mergeSha: string): Promise<ClaimedDeliveryRun | undefined> {
    const token = randomUUID();
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        id: string;
        project_id: string;
        merge_sha: string;
        authority_decision_id: string;
      }>(
        `UPDATE delivery_runs
            SET status = 'running', claim_owner = $4, claim_expires_at = 'infinity', updated_at = now()
          WHERE org_id = $1 AND project_id = $2 AND merge_sha = $3 AND status <> 'completed'
        RETURNING id, project_id, merge_sha, authority_decision_id`,
        [orgId, projectId, mergeSha, token],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            id: row.id,
            projectId: row.project_id,
            mergeSha: row.merge_sha,
            authorityDecisionId: row.authority_decision_id,
            token,
          };
    });
  }

  /**
   * Sign-of-life RENEWAL + fence check (progress-based, no timer): re-assert this drive
   * still holds the claim. Returns `false` when the token was superseded (a newer claim
   * took over) or the run left `running` — the driver ABORTS and records nothing terminal,
   * leaving the run for the live owner.
   */
  async renewClaim(orgId: string, deliveryRunId: string, token: string): Promise<boolean> {
    const result = await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `UPDATE delivery_runs SET updated_at = now()
          WHERE org_id = $1 AND id = $2 AND claim_owner = $3 AND status = 'running'`,
        [orgId, deliveryRunId, token],
      ),
    );
    return affectedOne(result);
  }

  /** The durable per-stage progress for a claimed run (drives the resume decision). */
  async loadStageProgress(orgId: string, deliveryRunId: string): Promise<Map<DeliveryStage, StageProgress>> {
    const rows = await runWithOrgScope(this.pool, orgId, (client) =>
      client
        .query<{ stage: string; status: string; attempt: number }>(
          `SELECT stage, status, attempt FROM delivery_stage_attempts
            WHERE org_id = $1 AND delivery_run_id = $2`,
          [orgId, deliveryRunId],
        )
        .then((r) => r.rows),
    );
    const progress = new Map<DeliveryStage, StageProgress>();
    for (const stage of DELIVERY_STAGES) progress.set(stage, { succeeded: false, attemptsSoFar: 0 });
    for (const row of rows) {
      if (!isDeliveryStage(row.stage)) continue;
      const prior = progress.get(row.stage) ?? { succeeded: false, attemptsSoFar: 0 };
      progress.set(row.stage, {
        succeeded: prior.succeeded || row.status === "succeeded",
        attemptsSoFar: Math.max(prior.attemptsSoFar, row.attempt),
      });
    }
    return progress;
  }

  /**
   * Open a new `running` attempt for a stage (attempt = prior max + 1, monotonic and
   * unbounded — resume/retry never caps), FENCED on the live token: the INSERT only lands
   * when this drive still owns the claim. Returns the attempt id, or `undefined` when the
   * claim was lost (the driver aborts).
   */
  async startStageAttempt(
    orgId: string,
    deliveryRunId: string,
    token: string,
    stage: DeliveryStage,
    attempt: number,
  ): Promise<string | undefined> {
    const id = `${deliveryRunId}:${stage}:${attempt}`;
    const result = await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `INSERT INTO delivery_stage_attempts (org_id, id, delivery_run_id, stage, ordinal, attempt, status, started_at)
         SELECT $1, $2, $3, $4, $5, $6, 'running', now()
          WHERE EXISTS (SELECT 1 FROM delivery_runs WHERE org_id = $1 AND id = $3 AND claim_owner = $7 AND status = 'running')
         ON CONFLICT (org_id, id) DO NOTHING`,
        [orgId, id, deliveryRunId, stage, stageOrdinal(stage), attempt, token],
      ),
    );
    return affectedOne(result) ? id : undefined;
  }

  /** Settle a stage attempt as durably SUCCEEDED (fenced). `false` ⇒ claim lost. */
  async succeedStageAttempt(orgId: string, deliveryRunId: string, token: string, attemptId: string): Promise<boolean> {
    return this.settleStageAttempt(orgId, deliveryRunId, token, attemptId, "succeeded", null);
  }

  /**
   * Settle a stage attempt as `retry_scheduled` — a DEGRADED, durable, NON-terminal state
   * (retried on the next wake), FENCED on the live token. `false` ⇒ claim lost.
   */
  async degradeStageAttempt(
    orgId: string,
    deliveryRunId: string,
    token: string,
    attemptId: string,
    classification: string,
  ): Promise<boolean> {
    return this.settleStageAttempt(orgId, deliveryRunId, token, attemptId, "retry_scheduled", classification);
  }

  private async settleStageAttempt(
    orgId: string,
    deliveryRunId: string,
    token: string,
    attemptId: string,
    status: "succeeded" | "retry_scheduled" | "failed",
    classification: string | null,
  ): Promise<boolean> {
    const result = await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        // Precondition `status = 'running'` (Finding 3): a `succeeded` attempt can never be
        // re-settled, even under the live token, if an attempt id were reused.
        `UPDATE delivery_stage_attempts
            SET status = $4, failure_classification = $5, completed_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'running'
            AND EXISTS (SELECT 1 FROM delivery_runs WHERE org_id = $1 AND id = $3 AND claim_owner = $6 AND status = 'running')`,
        [orgId, attemptId, deliveryRunId, status, classification, token],
      ),
    );
    return affectedOne(result);
  }

  /**
   * Mark the delivery COMPLETED — the ONLY terminal-success transition. FENCED on the live
   * token AND re-gated, IN THE SAME STATEMENT, on the durable signed `delivery.completed`
   * evidence row: completion is the evidence's consequence, never the loop's. `false` ⇒
   * the claim was lost OR no signed evidence exists → the driver does NOT report success.
   */
  async markCompleted(
    orgId: string,
    deliveryRunId: string,
    token: string,
    runId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        // The evidence EXISTS is scoped to THIS deliveryRunId (Finding 4: `payload->>'deliveryRunId'`)
        // so a sibling delivery's `delivery.completed` on the same run can never satisfy this one.
        `UPDATE delivery_runs
            SET status = 'completed', completed_at = now(), claim_owner = NULL, claim_expires_at = NULL,
                failure_classification = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND claim_owner = $3 AND status = 'running'
            AND EXISTS (SELECT 1 FROM events WHERE org_id = $1 AND run_id = $4 AND project_id = $5
                          AND event_type = 'delivery.completed' AND payload->>'deliveryRunId' = $2)`,
        [orgId, deliveryRunId, token, runId, projectId],
      ),
    );
    return affectedOne(result);
  }

  /** Mark the delivery DEGRADED — durable non-terminal, resumable next wake (fenced). `false` ⇒ claim lost. */
  async markDegraded(orgId: string, deliveryRunId: string, token: string, classification: string): Promise<boolean> {
    return this.settleRun(orgId, deliveryRunId, token, "degraded", classification);
  }

  /** Mark the delivery NEEDS_ATTENTION — an unexpected driver-level failure (fenced). `false` ⇒ claim lost. */
  async markNeedsAttention(
    orgId: string,
    deliveryRunId: string,
    token: string,
    classification: string,
  ): Promise<boolean> {
    return this.settleRun(orgId, deliveryRunId, token, "needs_attention", classification);
  }

  private async settleRun(
    orgId: string,
    deliveryRunId: string,
    token: string,
    status: Extract<DeliveryRunStatus, "degraded" | "needs_attention">,
    classification: string,
  ): Promise<boolean> {
    const result = await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `UPDATE delivery_runs
            SET status = $4, failure_classification = $5, completed_at = NULL,
                claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND claim_owner = $3 AND status = 'running'`,
        [orgId, deliveryRunId, token, status, classification],
      ),
    );
    return affectedOne(result);
  }
}

function isDeliveryStage(value: string): value is DeliveryStage {
  return (DELIVERY_STAGES as readonly string[]).includes(value);
}
