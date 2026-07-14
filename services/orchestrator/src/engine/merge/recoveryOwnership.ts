// Durable recovery-ownership proofs for conflict / gate-rework settlement.
// A typed receipt is NOT enough by itself: SpecNotRunnableError is never ownership,
// already_running must identify a live nonterminal run, and settlement rejects any
// owned receipt whose specId or durable identifiers do not match the queue entry.

import type pg from "pg";
import type { ConflictRecoveryDisposition, ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Run statuses that prove a recovery re-drive is actually live (cancelSpec's active set + paused). */
export const LIVE_NONTERMINAL_RUN_STATUSES = ["queued", "running", "paused", "halted"] as const;

/** Spec statuses that cannot be re-opened into a recovery owner (fail closed). */
export const RECOVERY_TERMINAL_SPEC_STATUSES = ["merged", "cancelled"] as const;

export function isRecoveryTerminalSpecStatus(status: string): boolean {
  return (RECOVERY_TERMINAL_SPEC_STATUSES as readonly string[]).includes(status);
}

/**
 * Independent durable proof: a live nonterminal run for this exact spec, ordered newest-first.
 * Mirrors cancelSpec's active-run read (plus `paused`); never trusts SpecNotRunnableError alone.
 */
export async function findLiveNonterminalRunForSpec(
  client: QueryClient,
  specId: string,
): Promise<{ runId: string; status: string } | undefined> {
  const result = await client.query<{ run_id: string; status: string }>(
    `SELECT run_id, status FROM runs
       WHERE spec_id = $1 AND status IN ('queued', 'running', 'paused', 'halted')
       ORDER BY started_at DESC NULLS LAST, run_id ASC
       LIMIT 1`,
    [specId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return { runId: row.run_id, status: row.status };
}

/** Spec status used to fail closed base-side replan of merged/cancelled targets. */
export async function loadSpecStatusForRecovery(client: QueryClient, specId: string): Promise<string | undefined> {
  const result = await client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1 LIMIT 1", [
    specId,
  ]);
  return result.rows[0]?.status;
}

/**
 * Settlement-time structural check: the owned receipt must name THIS queue entry's spec
 * and carry non-empty durable run identifiers (enqueued ids or already_running runId).
 * Does not re-query the store — routers must have verified live runs at mint time.
 */
export function isDurableOwnedReceipt(receipt: ConflictRecoveryReceipt, expectedSpecId: string): boolean {
  if (receipt.specId !== expectedSpecId) return false;
  if (receipt.run.kind === "enqueued") {
    return receipt.run.replanRunId.trim() !== "" && receipt.run.plannerTaskId.trim() !== "";
  }
  if (receipt.run.kind === "already_running") {
    return receipt.run.runId.trim() !== "";
  }
  return false;
}

/** Truthful recovery disposition labels for base-shift instrumentation (maps onto RebaseDecision). */
export type BaseShiftRecoveryDecision = "replanned" | "writer_rework" | "parked";

/** Truthful integration.rebase decision from a conflict recovery disposition. */
export function baseShiftDecisionFromRecovery(
  recovery: ConflictRecoveryDisposition | undefined,
): BaseShiftRecoveryDecision {
  if (recovery === undefined || recovery.kind === "unowned") return "replanned";
  if (recovery.kind === "parked") return "parked";
  return recovery.receipt.kind === "writer_rework" ? "writer_rework" : "replanned";
}
