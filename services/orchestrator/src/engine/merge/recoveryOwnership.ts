// Durable recovery-ownership proofs for conflict / gate-rework settlement.
// SpecNotRunnableError is never ownership. already_running requires an actively-driving
// run (queued/running/paused — NOT halted). Spec re-open is allowlisted only for
// open/in_flight/review. Settlement requires a typed RecoveryEvidencePort that
// re-reads runs/specs; absence of the port fails closed.

import type pg from "pg";
import type { ConflictRecoveryDisposition, ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Run statuses that prove an active owner is still driving work.
 * `halted` is terminal on the run SSE/DORA axis (routes/runs/sse.ts TERMINAL_STATUSES) —
 * a recoverable-halted re-drive is not proof of a live owner.
 */
export const ACTIVE_OWNER_RUN_STATUSES = ["queued", "running", "paused"] as const;

/**
 * Canonical recoverable SOURCE statuses for recovery re-open / re-drive (walkerPg
 * classifySpecStatus + SpecStatus vocabulary):
 *   - `open`      — walker-pending; replan enqueuer claim can take it
 *   - `in_flight` — occupying a slot (merge/conflict path, concurrent claim race)
 *   - `review`    — PR open / awaiting merge; still a live candidate
 * Missing, unknown, and terminal-blocked (`merged`/`halted`/`cancelled`/`needs_attention`)
 * fail closed.
 */
export const RECOVERABLE_SOURCE_SPEC_STATUSES = ["open", "in_flight", "review"] as const;

export function isRecoverableSourceSpecStatus(status: string): boolean {
  return (RECOVERABLE_SOURCE_SPEC_STATUSES as readonly string[]).includes(status);
}

export function isActiveOwnerRunStatus(status: string): boolean {
  return (ACTIVE_OWNER_RUN_STATUSES as readonly string[]).includes(status);
}

/** Settlement-time proof that a named run currently owns recovery for a exact spec. */
export interface RecoveryRunEvidence {
  runId: string;
  specId: string;
  runStatus: string;
  /** Present when the receipt named a planner/writer task id that was verified. */
  plannerTaskId?: string;
}

/**
 * Typed readback authority for non-fabricable ownership. Production wires a Pg
 * implementation that SELECTs runs (and tasks for enqueued receipts). Tests inject a
 * scripted port; absence of the port at settlement is fail-closed.
 */
export interface RecoveryEvidencePort {
  /**
   * Prove the owned receipt: receipt.specId === expectedSpecId, durable ids non-empty,
   * and the named runId/replanRunId exists on that exact spec in an active owner status.
   * Returns undefined when any check fails.
   */
  verifyOwnedReceipt(input: {
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined>;
}

/**
 * Active owner run for this exact spec (newest first). Never trusts SpecNotRunnableError.
 * Excludes `halted` — terminal on the run progress axis.
 */
export async function findActiveOwnerRunForSpec(
  client: QueryClient,
  specId: string,
): Promise<{ runId: string; status: string } | undefined> {
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
}

/** @deprecated alias — prefer findActiveOwnerRunForSpec */
export const findLiveNonterminalRunForSpec = findActiveOwnerRunForSpec;

/** Spec status for allowlist checks; undefined ⇒ missing row ⇒ fail closed. */
export async function loadSpecStatusForRecovery(client: QueryClient, specId: string): Promise<string | undefined> {
  const result = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1 LIMIT 1", [
    specId,
  ]);
  return result.rows[0]?.status;
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

/** @deprecated use hasStructuralOwnedReceiptShape + RecoveryEvidencePort */
export const isDurableOwnedReceipt = hasStructuralOwnedReceiptShape;

/** Truthful recovery disposition labels for base-shift instrumentation. */
export type BaseShiftRecoveryDecision = "replanned" | "writer_rework" | "parked";

export function baseShiftDecisionFromRecovery(
  recovery: ConflictRecoveryDisposition | undefined,
): BaseShiftRecoveryDecision {
  if (recovery === undefined || recovery.kind === "unowned") return "replanned";
  if (recovery.kind === "parked") return "parked";
  return recovery.receipt.kind === "writer_rework" ? "writer_rework" : "replanned";
}
