// The durable substrate for the resumable delivery DAG: an ORG-SCOPED store over the
// migration-0043 `delivery_runs` + `delivery_stage_attempts` tables. Every read and
// write runs through `runWithOrgScope`, so RLS denies cross-tenant rows by default (a
// query off the scoped client sees ZERO rows of another org).
//
// Doctrine (integrations-engine-surfaces §"Never hold an org-scoped DB transaction open
// across provider network I/O"): the store's transactions are SHORT — claim / record /
// settle. The provider I/O of a stage happens OUTSIDE any held transaction; its observed
// result is committed in a fresh scoped write. The run-level CLAIM is a fencing LEASE
// (progress-renewable, expiry only for crash takeover) — NOT a wall-clock work timeout
// and NOT a retry cap (attempts increase monotonically, unbounded).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { DELIVERY_STAGES, stageOrdinal, type DeliveryRunStatus, type DeliveryStage } from "./stageModel.js";

/** The fencing-lease TTL for a run/stage claim (crash-takeover window, not a work deadline). */
export const DELIVERY_CLAIM_LEASE_MS = 60_000;

/** A delivery run the driver has claimed for this pass. */
export interface ClaimedDeliveryRun {
  readonly id: string;
  readonly projectId: string;
  readonly mergeSha: string;
  readonly authorityDecisionId: string;
}

/** The durable progress of one stage across attempts. */
export interface StageProgress {
  readonly succeeded: boolean;
  readonly attemptsSoFar: number;
}

const STAGE_ROW = "org_id, delivery_run_id, stage, ordinal, attempt, status";

export class DeliveryRunStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly owner: string,
    private readonly leaseMs: number = DELIVERY_CLAIM_LEASE_MS,
  ) {}

  /**
   * CLAIM the delivery outbox row for a merged run, keyed on `(project, merge_sha)` —
   * the in-16 land transaction inserted exactly one such `delivery_runs` row. Claimable
   * when `pending`/`degraded`, or `running` with an EXPIRED lease (crash takeover). A
   * `completed` row (terminal success) or one another worker holds an unexpired lease on
   * is NOT claimable → returns `undefined` (the driver no-ops). `needs_attention` is left
   * for explicit operator/sweep intervention, never auto-reclaimed by a run wake.
   */
  async claim(orgId: string, projectId: string, mergeSha: string): Promise<ClaimedDeliveryRun | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        id: string;
        project_id: string;
        merge_sha: string;
        authority_decision_id: string;
      }>(
        `UPDATE delivery_runs
            SET status = 'running',
                claim_owner = $4,
                claim_expires_at = now() + make_interval(secs => $5),
                updated_at = now()
          WHERE org_id = $1 AND project_id = $2 AND merge_sha = $3
            AND (
              status IN ('pending', 'degraded')
              OR (status = 'running' AND (claim_expires_at IS NULL OR claim_expires_at < now()))
            )
        RETURNING id, project_id, merge_sha, authority_decision_id`,
        [orgId, projectId, mergeSha, this.owner, this.leaseMs / 1000],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            id: row.id,
            projectId: row.project_id,
            mergeSha: row.merge_sha,
            authorityDecisionId: row.authority_decision_id,
          };
    });
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
   * unbounded — resume/retry never caps). The claim lease fences a single driver. Returns
   * the durable attempt id the settle op keys on.
   */
  async startStageAttempt(
    orgId: string,
    deliveryRunId: string,
    stage: DeliveryStage,
    attempt: number,
  ): Promise<string> {
    const id = `${deliveryRunId}:${stage}:${attempt}`;
    await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `INSERT INTO delivery_stage_attempts
           (${STAGE_ROW}, id, claim_owner, claim_expires_at, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now() + make_interval(secs => $8), now())
         ON CONFLICT (org_id, id) DO NOTHING`,
        [orgId, deliveryRunId, stage, stageOrdinal(stage), attempt, id, this.owner, this.leaseMs / 1000],
      ),
    );
    return id;
  }

  /** Settle a stage attempt as durably SUCCEEDED (its external effect was confirmed). */
  async succeedStageAttempt(orgId: string, attemptId: string): Promise<void> {
    await this.settleStageAttempt(orgId, attemptId, "succeeded", null);
  }

  /**
   * Settle a stage attempt as `retry_scheduled` — a DEGRADED, durable, NON-terminal
   * state: the effect could not be confirmed, so the stage did not advance and will be
   * retried on the next wake (a fresh attempt). Records the failure classification.
   */
  async degradeStageAttempt(orgId: string, attemptId: string, classification: string): Promise<void> {
    await this.settleStageAttempt(orgId, attemptId, "retry_scheduled", classification);
  }

  private async settleStageAttempt(
    orgId: string,
    attemptId: string,
    status: "succeeded" | "retry_scheduled" | "failed",
    classification: string | null,
  ): Promise<void> {
    await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `UPDATE delivery_stage_attempts
            SET status = $3, failure_classification = $4,
                claim_owner = NULL, claim_expires_at = NULL, completed_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, attemptId, status, classification],
      ),
    );
  }

  /**
   * Mark the delivery COMPLETED — the ONLY terminal-success transition. Reached ONLY
   * after every applicable stage confirmed AND signed evidence was recorded (the
   * record_evidence gate). Releases the claim.
   */
  async markCompleted(orgId: string, deliveryRunId: string): Promise<void> {
    await this.settleRun(orgId, deliveryRunId, "completed", null, true);
  }

  /** Mark the delivery DEGRADED — an explicit durable non-terminal state, resumable next wake. */
  async markDegraded(orgId: string, deliveryRunId: string, classification: string): Promise<void> {
    await this.settleRun(orgId, deliveryRunId, "degraded", classification, false);
  }

  /** Mark the delivery NEEDS_ATTENTION — an unexpected driver-level failure (not auto-reclaimed). */
  async markNeedsAttention(orgId: string, deliveryRunId: string, classification: string): Promise<void> {
    await this.settleRun(orgId, deliveryRunId, "needs_attention", classification, false);
  }

  private async settleRun(
    orgId: string,
    deliveryRunId: string,
    status: Extract<DeliveryRunStatus, "completed" | "degraded" | "needs_attention">,
    classification: string | null,
    setCompletedAt: boolean,
  ): Promise<void> {
    await runWithOrgScope(this.pool, orgId, (client) =>
      client.query(
        `UPDATE delivery_runs
            SET status = $3,
                failure_classification = $4,
                completed_at = ${setCompletedAt ? "now()" : "NULL"},
                claim_owner = NULL, claim_expires_at = NULL,
                updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, deliveryRunId, status, classification],
      ),
    );
  }
}

function isDeliveryStage(value: string): value is DeliveryStage {
  return (DELIVERY_STAGES as readonly string[]).includes(value);
}
