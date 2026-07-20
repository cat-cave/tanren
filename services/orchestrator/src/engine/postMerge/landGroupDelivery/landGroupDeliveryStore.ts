// mq-13 durable store for the land-group delivery loop. The write path is org-scoped:
//   • claim — INSERT ... ON CONFLICT (org_id, land_group_id) DO NOTHING with `state='in_progress'`
//     (idempotency + cross-process ownership: exactly one worker owns a group's delivery; a
//     duplicate wake reads the existing row and no-ops on a terminal state).
//   • finalize — UPDATE the owned row to its TERMINAL state + stamp the strict receipt JSON,
//     then append the frozen `merge.land_group.delivery.{completed,failed}` event on the SAME
//     client (append only via EventStore). Fenced on the fencing token so a superseded owner
//     cannot overwrite a terminal row.
// Reads take an already-scoped client so a route composes them inside its own runWithOrgScope.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../../eventStore.js";
import {
  isTerminalDeliveryState,
  landGroupDeliveryIdempotencyKey,
  type LandGroupDeliveryReceiptV1,
  type LandGroupDeliveryState,
  validateLandGroupDeliveryReceipt,
} from "../../contracts/landGroupDeliveryReceipt.js";
import type { GroupDeliveryOutcome, GroupDeliveryPlan } from "./groupDeliveryCore.js";
import { buildDeliveryReceipt } from "./landGroupDeliveryReceipt.js";

/** The outcome of a claim attempt: OWNED (I drive the delivery) or an existing row's state. */
export type ClaimResult =
  | { readonly kind: "owned"; readonly token: string }
  | { readonly kind: "exists"; readonly state: LandGroupDeliveryState };

/**
 * The default LIVENESS LEASE (Finding 5 / Finding A): the max span an owner's claim may go
 * WITHOUT a progress sign-of-life before a fresh worker may TAKE OVER a stranded `in_progress`
 * row (a genuinely DEAD owner). This is a sign-of-life liveness bound (the ActivityWatchdog
 * pattern), NOT a work deadline — the delivery work itself is unbounded, and a LIVE owner
 * CONTINUOUSLY renews this lease from a background heartbeat (`renewClaim`) that runs THROUGHOUT
 * the drive (incl. during long external calls), so a live owner is NEVER taken over mid-work.
 * A SQL interval literal (passed as a parameter), so no wall-clock timer bounds any work.
 */
export const DEFAULT_CLAIM_LIVENESS_LEASE = "15 minutes";

function deliveryId(landGroupId: string): string {
  return `ldl-${landGroupId}`;
}

/** A read projection of one delivery loop row (the route/panel timeline). */
export interface LandGroupDeliverySummary {
  readonly id: string;
  readonly landGroupId: string;
  readonly projectId: string;
  readonly mainSha: string;
  readonly state: LandGroupDeliveryState;
  readonly disposition: string;
  readonly artifactDigest: string | null;
  readonly previewReleaseInstanceId: string | null;
  readonly productionReleaseInstanceId: string | null;
  readonly rollbackReleaseInstanceId: string | null;
  readonly attributedRunId: string | null;
  readonly receipt: LandGroupDeliveryReceiptV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DeliveryRow {
  readonly id: string;
  readonly land_group_id: string;
  readonly project_id: string;
  readonly main_sha: string;
  readonly state: string;
  readonly disposition: string;
  readonly artifact_digest: string | null;
  readonly preview_release_instance_id: string | null;
  readonly production_release_instance_id: string | null;
  readonly rollback_release_instance_id: string | null;
  readonly attributed_run_id: string | null;
  readonly receipt: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSummary(row: DeliveryRow): LandGroupDeliverySummary {
  return {
    id: row.id,
    landGroupId: row.land_group_id,
    projectId: row.project_id,
    mainSha: row.main_sha,
    state: row.state as LandGroupDeliveryState,
    disposition: row.disposition,
    artifactDigest: row.artifact_digest,
    previewReleaseInstanceId: row.preview_release_instance_id,
    productionReleaseInstanceId: row.production_release_instance_id,
    rollbackReleaseInstanceId: row.rollback_release_instance_id,
    attributedRunId: row.attributed_run_id,
    // A stored receipt re-validates strictly; a corrupt/absent receipt reads as null (never green).
    receipt: row.receipt === null ? null : safeValidateReceipt(row.receipt),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function safeValidateReceipt(raw: unknown): LandGroupDeliveryReceiptV1 | null {
  try {
    return validateLandGroupDeliveryReceipt(raw);
  } catch {
    return null;
  }
}

export class PgLandGroupDeliveryStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Claim ownership of a group's delivery. INSERTs `state='in_progress'` with a fresh fencing
   * token; ON CONFLICT (org_id, land_group_id) DO NOTHING. Returns `owned` (with the token) on a
   * fresh insert, else `exists` with the current durable state (the caller no-ops on a terminal
   * state, and conservatively no-ops on a non-terminal `in_progress` — another owner is driving).
   */
  async claim(input: {
    orgId: string;
    projectId: string;
    landGroupId: string;
    mainSha: string;
    /** The liveness lease a STALE `in_progress` claim may be taken over past (SQL interval). */
    leaseInterval?: string;
  }): Promise<ClaimResult> {
    const lease = input.leaseInterval ?? DEFAULT_CLAIM_LIVENESS_LEASE;
    const id = deliveryId(input.landGroupId);
    const token = `${id}#${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const idempotencyKey = landGroupDeliveryIdempotencyKey(input.landGroupId, input.mainSha);
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO land_group_delivery_loops
           (org_id, id, project_id, land_group_id, main_sha, state, disposition, idempotency_key, fencing_token)
         VALUES ($1,$2,$3,$4,$5,'in_progress','none',$6,$7)
         ON CONFLICT (org_id, land_group_id) DO NOTHING
         RETURNING id`,
        [input.orgId, id, input.projectId, input.landGroupId, input.mainSha, idempotencyKey, token],
      );
      if (inserted.rows[0] !== undefined) return { kind: "owned", token };
      // A row exists. If it is a STALE `in_progress` claim (a dead owner — no progress
      // sign-of-life within the liveness lease), TAKE IT OVER with a fresh token (Finding 5:
      // a crashed owner must not strand the group forever). The fenced UPDATE's
      // `updated_at < now() - lease` predicate makes takeover ATOMIC — two racing takeovers:
      // the first wins + bumps updated_at, the second's predicate no longer matches ⇒ 0 rows.
      // A TERMINAL row (idempotent no-op) or a FRESH in_progress row (a live owner) is never
      // taken over — so a live-but-slow owner (which renews between phases) never double-deploys.
      const takeover = await client.query<{ id: string }>(
        `UPDATE land_group_delivery_loops
            SET fencing_token = $3, updated_at = now()
          WHERE org_id = $1 AND land_group_id = $2 AND state = 'in_progress'
            AND updated_at < now() - $4::interval
          RETURNING id`,
        [input.orgId, input.landGroupId, token, lease],
      );
      if (takeover.rows[0] !== undefined) return { kind: "owned", token };
      const existing = (
        await client.query<{ state: string }>(
          "SELECT state FROM land_group_delivery_loops WHERE org_id = $1 AND land_group_id = $2",
          [input.orgId, input.landGroupId],
        )
      ).rows[0];
      return { kind: "exists", state: (existing?.state ?? "in_progress") as LandGroupDeliveryState };
    });
  }

  /**
   * Renew the owner's LIVENESS LEASE — a progress sign-of-life the loop calls between delivery
   * phases so a live owner's claim stays fresh (and is never taken over). Returns false when the
   * claim was TAKEN OVER (the token no longer owns the in_progress row) — the caller MUST abort
   * to avoid double-driving alongside the new owner. FENCED on the token.
   */
  async renewClaim(orgId: string, landGroupId: string, token: string): Promise<boolean> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const renewed = await client.query<{ id: string }>(
        `UPDATE land_group_delivery_loops SET updated_at = now()
          WHERE org_id = $1 AND land_group_id = $2 AND fencing_token = $3 AND state = 'in_progress'
          RETURNING id`,
        [orgId, landGroupId, token],
      );
      return renewed.rows[0] !== undefined;
    });
  }

  /**
   * Finalize an owned delivery: UPDATE the row (FENCED on the token, so a superseded owner cannot
   * clobber a terminal row) to its terminal state + the strict receipt JSON, then append the
   * frozen delivery event on the SAME client. Returns the persisted receipt.
   */
  async finalize(input: {
    plan: GroupDeliveryPlan;
    token: string;
    outcome: GroupDeliveryOutcome;
    /** The tail run's spec (the event's spec coordinate). */
    reason: string;
  }): Promise<LandGroupDeliveryReceiptV1> {
    const { plan, outcome } = input;
    const id = deliveryId(plan.landGroupId);
    const receipt = buildDeliveryReceipt(plan, outcome);
    return runWithOrgScope(this.pool, plan.orgId, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE land_group_delivery_loops
            SET state = $3, disposition = $4, artifact_digest = $5,
                preview_release_instance_id = $6, production_release_instance_id = $7,
                rollback_release_instance_id = $8, attributed_run_id = $9,
                receipt = $10::jsonb, updated_at = now()
          WHERE org_id = $1 AND id = $2 AND fencing_token = $11 AND state = 'in_progress'
          RETURNING id`,
        [
          plan.orgId,
          id,
          outcome.state,
          outcome.disposition,
          outcome.artifactDigest,
          outcome.previewReleaseInstanceId,
          outcome.productionReleaseInstanceId,
          outcome.rollbackReleaseInstanceId,
          outcome.attributedRunId,
          JSON.stringify(receipt),
          input.token,
        ],
      );
      // A lost fence (another owner already finalized) ⇒ do NOT emit a second event.
      if (updated.rows[0] === undefined) return receipt;
      const events = new PgEventStore(client);
      if (outcome.state === "completed") {
        await events.append({
          runId: plan.tailRunId,
          specId: plan.tailSpecId,
          projectId: plan.projectId,
          orgId: plan.orgId,
          eventType: "merge.land_group.delivery.completed",
          payload: {
            projectId: plan.projectId,
            landGroupId: plan.landGroupId,
            mainSha: plan.mainSha,
            artifactDigest: outcome.artifactDigest!,
            productionReleaseInstanceId: outcome.productionReleaseInstanceId!,
            memberCount: plan.memberRunIds.length,
            receiptId: id,
          },
        });
      } else {
        await events.append({
          runId: plan.tailRunId,
          specId: plan.tailSpecId,
          projectId: plan.projectId,
          orgId: plan.orgId,
          eventType: "merge.land_group.delivery.failed",
          payload: {
            projectId: plan.projectId,
            landGroupId: plan.landGroupId,
            mainSha: plan.mainSha,
            state: outcome.state,
            disposition: outcome.disposition,
            reason: input.reason,
          },
        });
      }
      return receipt;
    });
  }

  /**
   * Release an OWNED but un-finalized claim back to un-owned by DELETING the in-progress row —
   * used when the loop resolves the group has NO deploy target (nothing to deliver), so a later
   * wake is not permanently blocked by a stranded `in_progress` row.
   */
  async releaseClaim(orgId: string, landGroupId: string, token: string): Promise<void> {
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query(
        "DELETE FROM land_group_delivery_loops WHERE org_id = $1 AND land_group_id = $2 AND fencing_token = $3 AND state = 'in_progress'",
        [orgId, landGroupId, token],
      );
    });
  }

  /** Read one group's delivery summary (already org-scoped client). */
  static async getByLandGroup(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
    landGroupId: string,
  ): Promise<LandGroupDeliverySummary | undefined> {
    const result = await client.query<DeliveryRow>(
      `SELECT id, land_group_id, project_id, main_sha, state, disposition, artifact_digest,
              preview_release_instance_id, production_release_instance_id, rollback_release_instance_id,
              attributed_run_id, receipt, created_at, updated_at
         FROM land_group_delivery_loops
        WHERE org_id = $1 AND project_id = $2 AND land_group_id = $3
        LIMIT 1`,
      [orgId, projectId, landGroupId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toSummary(row);
  }

  /** List a project's delivery loops, newest first (already org-scoped client). */
  static async list(
    client: pg.PoolClient,
    orgId: string,
    projectId: string,
    limit: number,
  ): Promise<LandGroupDeliverySummary[]> {
    const result = await client.query<DeliveryRow>(
      `SELECT id, land_group_id, project_id, main_sha, state, disposition, artifact_digest,
              preview_release_instance_id, production_release_instance_id, rollback_release_instance_id,
              attributed_run_id, receipt, created_at, updated_at
         FROM land_group_delivery_loops
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [orgId, projectId, limit],
    );
    return result.rows.map(toSummary);
  }
}

export { isTerminalDeliveryState };
