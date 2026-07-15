// Atomic prepareSpecForRecovery SQL applier.
// Sole legal target status is always `open` (never caller-controlled).
// Optional steering note: replan/rework pass one; rollback prepares with none.

import type { PrepareSpecForRecoveryInput, PrepareSpecForRecoveryResult } from "./recoveryOwnership.js";
import { RECOVERABLE_SOURCE_SPEC_STATUSES } from "./recoveryOwnership.js";

type QueryClient = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rowCount?: number | null; rows?: Array<Record<string, unknown>> }>;
};

/**
 * ATOMIC recovery prepare. Locks the row; refuses missing/terminal/unknown with ZERO
 * writes; otherwise reopens to `open` and optionally appends steering in the caller's txn.
 */
export async function applyPrepareSpecForRecovery(
  client: QueryClient,
  input: PrepareSpecForRecoveryInput,
): Promise<PrepareSpecForRecoveryResult> {
  const locked = await client.query(`SELECT status FROM specs WHERE spec_id = $1 FOR UPDATE`, [input.specId]);
  const row = locked.rows?.[0] as { status: string } | undefined;
  if (row === undefined) {
    return { prepared: false, reason: "missing" };
  }
  const fromStatus = String(row.status);
  if (!(RECOVERABLE_SOURCE_SPEC_STATUSES as readonly string[]).includes(fromStatus)) {
    return { prepared: false, reason: "not_recoverable", status: fromStatus };
  }
  const note = input.steeringNote?.trim() ?? "";
  if (note.length > 0) {
    await client.query(
      `UPDATE specs
          SET description = description || E'\n\n[operator steering] ' || $2,
              status = 'open'
        WHERE spec_id = $1`,
      [input.specId, note],
    );
  } else {
    await client.query(`UPDATE specs SET status = 'open' WHERE spec_id = $1`, [input.specId]);
  }
  return { prepared: true, fromStatus };
}
