// Durable recovery-ownership proofs for conflict / gate-rework settlement.
// SpecNotRunnableError is never ownership. already_running requires an actively-driving
// run (queued/running/paused — NOT halted). Spec re-open is allowlisted only for
// open/in_flight/review via atomic prepareSpecForRecovery (always target status `open`).
// Settlement requires a typed RecoveryEvidencePort that re-reads under system/BYPASSRLS;
// absence fails closed.
//
// OWNERSHIP IDENTITY: replan/rework receipts name the NEW owner run + spec
// (+ planner task for enqueued). The stale PR/head being replaced is never evidence.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ConflictRecoveryReceipt } from "../contracts/conflictResolution.js";
import { isPool, type QueryClient } from "../data/orgScopedDb.js";

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

/** Settlement-time proof that a named run currently owns recovery for an exact spec. */
export interface RecoveryRunEvidence {
  orgId: string;
  projectId: string;
  runId: string;
  specId: string;
  runStatus: string;
  plannerTaskId?: string;
}

/**
 * Typed readback authority for ownership that cannot be fabricated. Production wires
 * PgRecoveryEvidencePort (system/BYPASSRLS scope). Tests inject a scripted port;
 * absence of the port at settlement is fail-closed.
 */
export interface RecoveryEvidencePort {
  verifyOwnedReceipt(input: {
    expectedOrgId: string;
    expectedProjectId: string;
    expectedSpecId: string;
    receipt: ConflictRecoveryReceipt;
  }): Promise<RecoveryRunEvidence | undefined>;
}

/**
 * Narrow a QueryClient to a real Pool for runWithOrgScope. No `as pg.Pool` cast —
 * `isPool` is the honest discriminator (rejects bare query-only clients).
 */
function requirePool(client: QueryClient, context: string): pg.Pool {
  if (!isPool(client)) {
    throw new Error(`${context} requires a Pool-capable client (connect), not a bare query-only client`);
  }
  return client;
}

/**
 * Active owner run for this exact spec under the tenant org GUC (RLS-visible).
 * Never trusts SpecNotRunnableError alone. Uses a short runWithOrgScope txn.
 * Accepts QueryClient so workflow seams need no cast — narrows via isPool.
 */
export async function findActiveOwnerRunForSpec(
  pool: QueryClient,
  orgId: string,
  specId: string,
): Promise<{ runId: string; status: string } | undefined> {
  const realPool = requirePool(pool, "findActiveOwnerRunForSpec");
  return runWithOrgScope(realPool, orgId, async (client): Promise<{ runId: string; status: string } | undefined> => {
    const result = await client.query<{ run_id: string; status: string }>(
      `SELECT run_id, status FROM runs
         WHERE spec_id = $1 AND status IN ('queued', 'running', 'paused')
         ORDER BY started_at DESC NULLS LAST, run_id ASC
         LIMIT 1`,
      [specId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return { runId: row.run_id, status: row.status };
  });
}

/**
 * Structural pre-check only (non-empty ids + matching specId). NEVER sufficient for
 * settlement — callers must still pass {@link RecoveryEvidencePort.verifyOwnedReceipt}.
 * Receipt ids name the NEW owner run/task, never the stale PR/head being replaced.
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

/**
 * Shared settlement-time ownership proof for conflict replan AND writer rework.
 * Missing port, wrong/missing store rows, inactive run, or failed readback ⇒ not ok
 * (caller parks needs_attention before dequeue).
 */
export async function verifyRecoveryOwnership(input: {
  evidence: RecoveryEvidencePort | undefined;
  expectedOrgId: string;
  expectedProjectId: string;
  expectedSpecId: string;
  receipt: ConflictRecoveryReceipt;
  contextMessage: string;
}): Promise<{ ok: true; evidence: RecoveryRunEvidence } | { ok: false; message: string }> {
  if (input.evidence === undefined) {
    return {
      ok: false,
      message:
        `recovery ownership cannot be verified for ${input.expectedSpecId}: no RecoveryEvidencePort is wired ` +
        `(fail closed — ownership is the new owner run+spec+task, never a stale PR/head): ${input.contextMessage}`,
    };
  }
  const evidence = await input.evidence.verifyOwnedReceipt({
    expectedOrgId: input.expectedOrgId,
    expectedProjectId: input.expectedProjectId,
    expectedSpecId: input.expectedSpecId,
    receipt: input.receipt,
  });
  if (evidence === undefined) {
    return {
      ok: false,
      message:
        `recovery ownership receipt failed settlement-time store readback for ${input.expectedSpecId} ` +
        `(new owner run+spec+task must re-verify; stale PR/head is not evidence): ${input.contextMessage}`,
    };
  }
  return { ok: true, evidence };
}
