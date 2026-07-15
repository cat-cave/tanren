// Durable recovery-ownership proofs for conflict / gate-rework settlement.
// SpecNotRunnableError is never ownership. already_running requires an actively-driving
// run (queued/running/paused — NOT halted). Spec re-open is allowlisted only for
// open/in_flight/review via atomic prepareSpecForRecovery. Settlement requires a typed
// RecoveryEvidencePort that re-reads under system/BYPASSRLS scope; absence fails closed.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ConflictRecoveryDisposition, ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";

/**
 * Run statuses that prove an active owner is still driving work.
 * `halted` is terminal on the run SSE/DORA axis (routes/runs/sse.ts TERMINAL_STATUSES).
 */
export const ACTIVE_OWNER_RUN_STATUSES = ["queued", "running", "paused"] as const;

/**
 * Canonical recoverable SOURCE statuses for recovery re-open / re-drive:
 *   - `open`      — walker-pending; run-create claim can take it
 *   - `in_flight` — occupying a slot (merge/conflict path, concurrent claim race)
 *   - `review`    — PR open / awaiting merge; still a live candidate
 * Missing, unknown, and terminal-blocked fail closed (no steering, no reopen).
 */
export const RECOVERABLE_SOURCE_SPEC_STATUSES = ["open", "in_flight", "review"] as const;

export function isRecoverableSourceSpecStatus(status: string): boolean {
  return (RECOVERABLE_SOURCE_SPEC_STATUSES as readonly string[]).includes(status);
}

export function isActiveOwnerRunStatus(status: string): boolean {
  return (ACTIVE_OWNER_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Atomic recovery prepare input (steering + allowlisted reopen). Lives here so the
 * allowlist and the writer contract share one vocabulary without bloating runStateWriter.
 */
export interface PrepareSpecForRecoveryInput {
  specId: string;
  orgId: string;
  steeringNote: string;
  reopenStatus: string;
}

export type PrepareSpecForRecoveryResult =
  | { prepared: true; fromStatus: string }
  | { prepared: false; reason: "missing" | "not_recoverable"; status?: string };

/** Settlement-time proof that a named run currently owns recovery for an exact spec. */
export interface RecoveryRunEvidence {
  runId: string;
  specId: string;
  runStatus: string;
  plannerTaskId?: string;
}

/**
 * Typed readback authority for non-fabricable ownership. Production wires
 * PgRecoveryEvidencePort (system/BYPASSRLS scope). Tests inject a scripted port;
 * absence of the port at settlement is fail-closed.
 */
export interface RecoveryEvidencePort {
  verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined>;
}

/**
 * Active owner run for this exact spec under the tenant org GUC (RLS-visible).
 * Never trusts SpecNotRunnableError alone. Uses a short runWithOrgScope txn.
 */
export async function findActiveOwnerRunForSpec(
  pool: pg.Pool,
  orgId: string,
  specId: string,
): Promise<{ runId: string; status: string } | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM runs
         WHERE spec_id = $1 AND status IN ('queued', 'running', 'paused')
         ORDER BY started_at DESC NULLS LAST, run_id ASC
         LIMIT 1`,
      [specId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { runId: row.run_id, status: row.status };
  });
}

/**
 * Spec status under the tenant org GUC. Undefined ⇒ missing row ⇒ fail closed.
 * Prefer atomic prepareSpecForRecovery for mutations; this is a scoped read helper.
 */
export async function loadSpecStatusForRecovery(
  pool: pg.Pool,
  orgId: string,
  specId: string,
): Promise<string | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1 LIMIT 1", [
      specId,
    ]);
    return result.rows[0]?.status;
  });
}

/**
 * Structural pre-check only (non-empty ids + matching specId). NEVER sufficient for
 * settlement — callers must still pass {@link RecoveryEvidencePort.verifyOwnedReceipt}.
 */
export function hasStructuralOwnedReceiptShape(receipt: ConflictRecoveryReceipt, expectedSpecId: string): boolean {
  if (receipt.specId !== expectedSpecId) return false;
  if (receipt.run.kind === "enqueued") {
    return receipt.run.replanRunId.trim() !== "" && receipt.run.plannerTaskId.trim() !== "";
  }
  if (receipt.run.kind === "already_running") {
    return receipt.run.runId.trim() !== "";
  }
  return false;
}

/** Truthful recovery disposition labels for base-shift instrumentation. */
export type BaseShiftRecoveryDecision = "replanned" | "writer_rework" | "parked";

export function baseShiftDecisionFromRecovery(
  recovery: ConflictRecoveryDisposition | undefined,
): BaseShiftRecoveryDecision {
  if (recovery === undefined || recovery.kind === "unowned") return "replanned";
  if (recovery.kind === "parked") return "parked";
  return recovery.receipt.kind === "writer_rework" ? "writer_rework" : "replanned";
}
