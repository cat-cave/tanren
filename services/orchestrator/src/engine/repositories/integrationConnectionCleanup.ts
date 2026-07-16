import type { IntegrationQueryClient } from "./integrationQuery.js";

export interface TerminalStagedCleanupCandidate {
  orgId: string;
  operationId: string;
  stagedSecretHandle: string;
}

export async function listTerminalStagedCleanupCandidates(
  client: IntegrationQueryClient,
  limit = 100,
): Promise<TerminalStagedCleanupCandidate[]> {
  const result = await client.query(
    `SELECT org_id, id, staged_secret_handle
     FROM org_integration_connection_operations
     WHERE staged_secret_handle IS NOT NULL
       AND ((stage = 'completed' AND status = 'completed')
         OR (stage = 'failed' AND status = 'failed'))
     ORDER BY updated_at, id
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((raw) => {
    const row = raw as { org_id: string; id: string; staged_secret_handle: string };
    return { orgId: row.org_id, operationId: row.id, stagedSecretHandle: row.staged_secret_handle };
  });
}

export async function markTerminalStagedCleanupComplete(
  client: IntegrationQueryClient,
  candidate: TerminalStagedCleanupCandidate,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET staged_secret_handle = NULL,
         compensation_state = compensation_state || '{"stagedCleanup":"completed"}'::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2 AND staged_secret_handle = $3
       AND ((stage = 'completed' AND status = 'completed')
         OR (stage = 'failed' AND status = 'failed'))
     RETURNING id`,
    [candidate.orgId, candidate.operationId, candidate.stagedSecretHandle],
  );
  return (result.rowCount ?? 0) === 1;
}
