import type { PrincipalCandidate } from "../contracts/integrationAuthority.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

type OperationTransitionRow = {
  stage: string;
  status: string;
  staged_secret_handle: string | null;
  candidate_principals: PrincipalCandidate[];
  verified_auth_kind: string | null;
  verified_scopes: string[] | null;
  verified_expires_at: Date | string | null;
  verification_fingerprint: string | null;
  reserved_connection_id: string | null;
  failure_classification: string | null;
};

async function operationTransitionRow(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
): Promise<OperationTransitionRow> {
  const result = await client.query(
    `SELECT stage, status, staged_secret_handle, candidate_principals,
            verified_auth_kind, verified_scopes, verified_expires_at,
            verification_fingerprint, reserved_connection_id, failure_classification
     FROM org_integration_connection_operations
     WHERE org_id = $1 AND id = $2`,
    [orgId, operationId],
  );
  const row = result.rows[0] as OperationTransitionRow | undefined;
  if (row === undefined) throw new Error("operation_missing_during_transition");
  return row;
}

function sameStrings(left: string[] | null, right: string[]): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

function sameInstant(left: Date | string | null, right: string | undefined): boolean {
  if (left === null || right === undefined) return left === null && right === undefined;
  return new Date(left).toISOString() === new Date(right).toISOString();
}

export async function markOperationStaged(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  stagedHandle: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'credential_staged', status = 'in_progress',
         staged_secret_handle = $3, updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND verification_fingerprint IS NULL AND reserved_connection_id IS NULL
       AND ((stage = 'created' AND status = 'pending' AND staged_secret_handle IS NULL)
         OR (stage = 'credential_staged' AND status = 'in_progress' AND staged_secret_handle = $3))
     RETURNING id`,
    [orgId, operationId, stagedHandle],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  const row = await operationTransitionRow(client, orgId, operationId);
  return row.stage === "credential_staged" && row.staged_secret_handle === stagedHandle;
}

export async function markAwaitingPrincipalSelection(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  candidates: PrincipalCandidate[],
  verified?: { authKind: string; scopes: string[]; expiresAt?: string },
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'awaiting_principal_selection', status = 'awaiting_principal_selection',
         candidate_principals = $3::jsonb,
         verified_auth_kind = $4, verified_scopes = $5::text[], verified_expires_at = $6::timestamptz,
         updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND stage = 'credential_staged' AND status = 'in_progress'
       AND staged_secret_handle IS NOT NULL
       AND verification_fingerprint IS NULL AND reserved_connection_id IS NULL
     RETURNING id`,
    [
      orgId,
      operationId,
      JSON.stringify(candidates),
      verified?.authKind ?? "api_key",
      verified?.scopes ?? [],
      verified?.expiresAt ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  const row = await operationTransitionRow(client, orgId, operationId);
  return (
    row.stage === "awaiting_principal_selection" &&
    row.status === "awaiting_principal_selection" &&
    JSON.stringify(row.candidate_principals) === JSON.stringify(candidates) &&
    row.verified_auth_kind === (verified?.authKind ?? "api_key") &&
    sameStrings(row.verified_scopes, verified?.scopes ?? []) &&
    sameInstant(row.verified_expires_at, verified?.expiresAt)
  );
}

export async function markOperationFailed(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  classification: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'failed', status = 'failed', failure_classification = $3,
         compensation_state = compensation_state || '{"stagedCleanup":"pending"}'::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND verification_fingerprint IS NULL AND reserved_connection_id IS NULL
       AND ((stage IN ('created','credential_staged','verifying') AND status IN ('pending','in_progress'))
         OR (stage = 'awaiting_principal_selection' AND status = 'awaiting_principal_selection'))
     RETURNING id`,
    [orgId, operationId, classification],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  const row = await operationTransitionRow(client, orgId, operationId);
  return row.stage === "failed" && row.status === "failed" && row.failure_classification === classification;
}

export async function markOperationRetryable(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  classification: string,
  retryAfter?: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET failure_classification = $3,
         compensation_state = compensation_state || $4::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2
       AND ((stage = 'credential_staged' AND status = 'in_progress')
         OR (stage = 'awaiting_principal_selection' AND status = 'awaiting_principal_selection'))
       AND verification_fingerprint IS NULL AND reserved_connection_id IS NULL
     RETURNING id`,
    [orgId, operationId, classification, JSON.stringify(retryAfter === undefined ? {} : { retryAfter })],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  await operationTransitionRow(client, orgId, operationId);
  return false;
}

export async function markOperationActivationFailed(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  classification: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET stage = 'failed', status = 'failed', failure_classification = $3,
         compensation_state = compensation_state || '{"stagedCleanup":"pending"}'::jsonb,
         updated_at = now()
     WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
       AND stage IN ('finalizing','activate_pending')
     RETURNING id`,
    [orgId, operationId, classification],
  );
  if ((result.rowCount ?? 0) === 1) return;
  const row = await operationTransitionRow(client, orgId, operationId);
  if (row.stage === "failed" && row.status === "failed" && row.failure_classification === classification) return;
  throw new Error("operation_activation_terminal_conflict");
}

/**
 * Record retry diagnostics while a reserved operation remains non-terminal.
 * Exact stage/status predicates prevent a delayed failure from rewriting a
 * concurrently completed or terminally failed receipt.
 */
export async function recordNonterminalFailure(
  client: IntegrationQueryClient,
  orgId: string,
  operationId: string,
  classification: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE org_integration_connection_operations
     SET failure_classification = $3, updated_at = now()
     WHERE org_id = $1 AND id = $2 AND status = 'in_progress'
       AND stage IN ('finalizing','activate_pending')
     RETURNING id`,
    [orgId, operationId, classification],
  );
  if ((result.rowCount ?? 0) === 1) return true;
  const row = await operationTransitionRow(client, orgId, operationId);
  return (
    row.status === "in_progress" &&
    (row.stage === "finalizing" || row.stage === "activate_pending") &&
    row.failure_classification === classification
  );
}
