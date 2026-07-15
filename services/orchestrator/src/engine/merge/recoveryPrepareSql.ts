// Atomic prepareSpecForRecovery SQL applier (steering + allowlisted reopen).
// Shared by DirectRunStateWriter, the control-plane route, and dashboard replanWithSteering.

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
 * writes; otherwise appends steering and sets reopen status in the caller's transaction.
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
  await client.query(
    `UPDATE specs
        SET description = description || E'\n\n[operator steering] ' || $2,
            status = $3
      WHERE spec_id = $1`,
    [input.specId, input.steeringNote, input.reopenStatus],
  );
  return { prepared: true, fromStatus };
}
