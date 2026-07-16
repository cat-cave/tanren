/** Unit-fake durable-operation handlers. Not a SQL/transaction/RLS proof. */
import type { IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";
import { rowsOf } from "./integrationMemoryQueries.js";
import type { MemoryOperation } from "./integrationMemoryTables.js";

export function dispatchOperationSql(
  operations: MemoryOperation[],
  sql: string,
  params: unknown[],
): IntegrationQueryResult | null {
  if (sql.startsWith("INSERT INTO org_integration_connection_operations")) {
    return insertOperation(operations, sql, params);
  }
  if (sql.startsWith("UPDATE org_integration_connection_operations")) {
    return updateOperation(operations, sql, params);
  }
  if (sql.includes("FROM org_integration_connection_operations") && sql.includes("idempotency_key")) {
    const [orgId, idempotencyKey] = params as [string, string];
    const op = operations.find((row) => row.org_id === orgId && row.idempotency_key === idempotencyKey);
    return rowsOf(
      op
        ? [
            {
              id: op.id,
              provider_kind: op.provider_kind,
              stage: op.stage,
              status: op.status,
              connection_id: op.connection_id,
              target_auth_generation: op.target_auth_generation,
              staged_secret_handle: op.staged_secret_handle,
              operation_kind: op.operation_kind,
              actor_id: op.actor_id,
              request_fingerprint: op.request_fingerprint,
            },
          ]
        : [],
    );
  }
  if (sql.startsWith("SELECT id, provider_kind, connection_id, operation_kind, stage, status,")) {
    const [orgId, operationId] = params as [string, string];
    const op = operations.find((row) => row.org_id === orgId && row.id === operationId);
    return rowsOf(op ? [{ ...op }] : []);
  }
  if (sql.startsWith("SELECT org_id, id, provider_kind, actor_id, staged_secret_handle, stage, status")) {
    const [orgId, operationId] = params as [string, string];
    const op = operations.find((row) => row.org_id === orgId && row.id === operationId);
    return rowsOf(
      op
        ? [
            {
              org_id: op.org_id,
              id: op.id,
              provider_kind: op.provider_kind,
              actor_id: op.actor_id,
              staged_secret_handle: op.staged_secret_handle,
              stage: op.stage,
              status: op.status,
            },
          ]
        : [],
    );
  }
  if (sql.startsWith("SELECT stage, status, staged_secret_handle, candidate_principals,")) {
    const [orgId, operationId] = params as [string, string];
    const op = operations.find((row) => row.org_id === orgId && row.id === operationId);
    return rowsOf(op ? [{ ...op }] : []);
  }
  if (sql.startsWith("SELECT stage, status FROM org_integration_connection_operations")) {
    const [orgId, operationId, connectionId, credentialRef, authGeneration, grantId, grantGeneration] = params as [
      string,
      string,
      string,
      string,
      number,
      string,
      number,
    ];
    const op = operations.find(
      (row) =>
        row.org_id === orgId &&
        row.id === operationId &&
        row.reserved_connection_id === connectionId &&
        row.reserved_credential_ref === credentialRef &&
        row.target_auth_generation === authGeneration &&
        row.target_grant_id === grantId &&
        row.target_grant_generation === grantGeneration,
    );
    return rowsOf(op ? [{ stage: op.stage, status: op.status }] : []);
  }
  if (sql.startsWith("SELECT stage, status, reserved_credential_ref")) {
    const [orgId, operationId] = params as [string, string];
    const op = operations.find((row) => row.org_id === orgId && row.id === operationId);
    return rowsOf(
      op ? [{ stage: op.stage, status: op.status, reserved_credential_ref: op.reserved_credential_ref }] : [],
    );
  }
  if (sql.startsWith("SELECT id FROM org_integration_connection_operations") && sql.includes("selected_principal_id")) {
    const [orgId, providerKind, principalId, operationId] = params as [string, string, string, string];
    const op = operations.find(
      (row) =>
        row.org_id === orgId &&
        row.provider_kind === providerKind &&
        row.selected_principal_id === principalId &&
        row.status === "in_progress" &&
        row.id !== operationId,
    );
    return rowsOf(op ? [{ id: op.id }] : []);
  }
  return null;
}

function insertOperation(operations: MemoryOperation[], sql: string, params: unknown[]): IntegrationQueryResult {
  const [orgId, id, providerKind, connectionId, operationKind, idempotencyKey, actorId, requestFingerprint] =
    params as [string, string, string, string | null, string, string, string, string];
  const existing = operations.find((row) => row.org_id === orgId && row.idempotency_key === idempotencyKey);
  if (existing !== undefined && sql.includes("ON CONFLICT")) return rowsOf([]);
  operations.push({
    id,
    org_id: orgId,
    provider_kind: providerKind,
    connection_id: connectionId,
    operation_kind: operationKind,
    stage: "created",
    status: "pending",
    idempotency_key: idempotencyKey,
    actor_id: actorId,
    request_fingerprint: requestFingerprint,
    verification_fingerprint: null,
    verified_principal: null,
    verified_auth_kind: null,
    verified_scopes: null,
    verified_expires_at: null,
    reserved_connection_id: null,
    reserved_credential_ref: null,
    staged_secret_handle: null,
    candidate_principals: [],
    selected_principal_id: null,
    target_auth_generation: null,
    target_grant_id: null,
    target_grant_generation: null,
    reserved_capabilities: null,
    reserved_operations: null,
    reserved_policy_revision: null,
    reserved_consent_revision: null,
    reserved_consented_at: null,
    failure_classification: null,
    compensation_state: {},
    created_at: new Date().toISOString(),
  });
  return rowsOf([]);
}

function updateOperation(operations: MemoryOperation[], sql: string, params: unknown[]): IntegrationQueryResult {
  const [orgId, operationId] = params as [string, string];
  const op = operations.find((row) => row.org_id === orgId && row.id === operationId);
  if (op === undefined) return rowsOf([]);

  if (sql.includes("SET stage = 'credential_staged'")) {
    const canStage =
      op.verification_fingerprint === null &&
      op.reserved_connection_id === null &&
      ((op.stage === "created" && op.status === "pending" && op.staged_secret_handle === null) ||
        (op.stage === "credential_staged" &&
          op.status === "in_progress" &&
          op.staged_secret_handle === (params[2] as string)));
    if (!canStage) return rowsOf([]);
    op.stage = "credential_staged";
    op.status = "in_progress";
    op.staged_secret_handle = params[2] as string;
  } else if (sql.includes("SET stage = 'awaiting_principal_selection'")) {
    if (
      op.stage !== "credential_staged" ||
      op.status !== "in_progress" ||
      op.staged_secret_handle === null ||
      op.verification_fingerprint !== null ||
      op.reserved_connection_id !== null
    ) {
      return rowsOf([]);
    }
    op.stage = "awaiting_principal_selection";
    op.status = "awaiting_principal_selection";
    op.candidate_principals = JSON.parse(params[2] as string) as unknown[];
    op.verified_auth_kind = params[3] as string;
    op.verified_scopes = params[4] as string[];
    op.verified_expires_at = params[5] as string | null;
  } else if (sql.includes("SET stage = 'finalizing'")) {
    reserveOperation(op, params);
  } else if (sql.includes("SET stage = 'activate_pending'")) {
    const matches =
      op.reserved_connection_id === params[2] &&
      op.reserved_credential_ref === params[3] &&
      op.target_auth_generation === params[4] &&
      op.target_grant_id === params[5] &&
      op.target_grant_generation === params[6];
    if (!matches) return rowsOf([]);
    op.stage = "activate_pending";
    op.failure_classification = null;
  } else if (sql.includes("SET stage = 'completed', status = 'completed'")) {
    op.stage = "completed";
    op.status = "completed";
    op.connection_id = params[2] as string;
    op.compensation_state = { ...op.compensation_state, stagedCleanup: "pending" };
  } else if (sql.includes("SET stage = 'failed', status = 'failed'")) {
    const activationFailure = sql.includes("stage IN ('finalizing','activate_pending')");
    const canFail = activationFailure
      ? op.status === "in_progress" && ["finalizing", "activate_pending"].includes(op.stage)
      : op.verification_fingerprint === null &&
        op.reserved_connection_id === null &&
        ((["created", "credential_staged", "verifying"].includes(op.stage) &&
          ["pending", "in_progress"].includes(op.status)) ||
          (op.stage === "awaiting_principal_selection" && op.status === "awaiting_principal_selection"));
    if (!canFail) return rowsOf([]);
    op.stage = "failed";
    op.status = "failed";
    op.failure_classification = params[2] as string;
    op.compensation_state = { ...op.compensation_state, stagedCleanup: "pending" };
  } else if (sql.includes("SET staged_secret_handle = NULL")) {
    op.staged_secret_handle = null;
    op.compensation_state = { ...op.compensation_state, stagedCleanup: "completed" };
  } else if (sql.includes("compensation_state = compensation_state || $4::jsonb")) {
    if (
      !(
        (op.stage === "credential_staged" && op.status === "in_progress") ||
        (op.stage === "awaiting_principal_selection" && op.status === "awaiting_principal_selection")
      ) ||
      op.verification_fingerprint !== null ||
      op.reserved_connection_id !== null
    ) {
      return rowsOf([]);
    }
    op.failure_classification = params[2] as string;
    op.compensation_state = { ...op.compensation_state, ...(JSON.parse(params[3] as string) as object) };
  } else if (sql.includes("SET failure_classification = $3")) {
    op.failure_classification = params[2] as string;
  }
  return rowsOf([{ id: op.id }]);
}

function reserveOperation(op: MemoryOperation, params: unknown[]): void {
  op.stage = "finalizing";
  op.status = "in_progress";
  op.verification_fingerprint = params[2] as string;
  op.verified_principal = JSON.parse(params[3] as string) as unknown;
  op.verified_auth_kind = params[4] as string;
  op.verified_scopes = params[5] as string[];
  op.verified_expires_at = params[6] as string | null;
  op.selected_principal_id = params[7] as string;
  op.reserved_connection_id = params[8] as string;
  op.reserved_credential_ref = params[9] as string;
  op.target_auth_generation = params[10] as number;
  op.target_grant_id = params[11] as string;
  op.target_grant_generation = params[12] as number;
  op.reserved_capabilities = params[13] as string[];
  op.reserved_operations = params[14] as string[];
  op.reserved_policy_revision = params[15] as string;
  op.reserved_consent_revision = params[16] as string;
  op.reserved_consented_at = params[17] as string;
}
