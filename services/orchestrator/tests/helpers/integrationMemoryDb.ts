import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
  MemorySelection,
} from "./integrationMemoryTables.js";
import { finalizeLinkInMemory } from "./integrationMemoryFinalize.js";
import { eligibilityQuery, insertSelection, listInventory, rowsOf } from "./integrationMemoryQueries.js";
/** Unit-fake integration tables — not a SQL/transaction/RLS proof. */
import type { IntegrationQueryClient, IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";

export class IntegrationMemoryDb {
  connections: MemoryConnection[] = [];
  authGenerations: MemoryAuthGeneration[] = [];
  grants: MemoryGrant[] = [];
  grantGenerations: MemoryGrantGeneration[] = [];
  operations: MemoryOperation[] = [];
  selections: MemorySelection[] = [];
  appEnv: Array<Record<string, unknown>> = [];
  projectOrg = new Map<string, string>();

  seedProject(projectId: string, orgId: string): void {
    this.projectOrg.set(projectId, orgId);
  }

  clientForOrg(orgId: string): IntegrationQueryClient {
    return {
      query: async (sql: string, params: unknown[] = []): Promise<IntegrationQueryResult> =>
        this.dispatch(sql, params, orgId),
    };
  }

  private dispatch(rawSql: string, params: unknown[], scopedOrgId: string): IntegrationQueryResult {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();

    // Unit fake: structured table ops only. Not a SQL/transaction/RLS proof.
    if (sql.includes("pg_advisory_xact_lock")) {
      return rowsOf([{ pg_advisory_xact_lock: 1 }]);
    }

    if (
      sql.includes("FROM project_app_env") ||
      sql.includes("INTO project_app_env") ||
      sql.startsWith("DELETE FROM project_app_env")
    ) {
      return this.dispatchAppEnv(sql, params, scopedOrgId);
    }

    if (sql.startsWith("INSERT INTO org_integration_connection_operations")) {
      return this.insertOperation(sql, params);
    }
    if (sql.startsWith("UPDATE org_integration_connection_operations")) {
      return this.updateOperation(sql, params);
    }
    if (sql.includes("FROM org_integration_connection_operations") && sql.includes("idempotency_key")) {
      const [orgId, idempotencyKey] = params as [string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.idempotency_key === idempotencyKey);
      return rowsOf(
        op
          ? [
              {
                id: op.id,
                stage: op.stage,
                status: op.status,
                connection_id: op.connection_id,
                target_auth_generation: op.target_auth_generation,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith("SELECT id, provider_kind, connection_id, operation_kind, stage, status,")) {
      const [orgId, operationId] = params as [string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      return rowsOf(op ? [{ ...op, compensation_state: op.compensation_state }] : []);
    }
    if (sql.startsWith("SELECT id FROM org_integration_connection_operations")) {
      const [orgId, operationId, generation] = params as [string, string, number];
      const op = this.operations.find(
        (row) =>
          row.org_id === orgId &&
          row.id === operationId &&
          row.target_auth_generation === generation &&
          row.status === "in_progress" &&
          row.stage === "finalizing",
      );
      return rowsOf(op ? [{ id: op.id }] : []);
    }
    if (
      sql.startsWith("SELECT id, current_auth_generation") ||
      sql.startsWith("SELECT id, current_auth_generation, status")
    ) {
      const [orgId, providerKind, principalId] = params as [string, string, string];
      const conn = this.connections.find(
        (row) =>
          row.org_id === orgId && row.provider_kind === providerKind && row.provider_principal_id === principalId,
      );
      return rowsOf(
        conn ? [{ id: conn.id, current_auth_generation: conn.current_auth_generation, status: conn.status }] : [],
      );
    }
    if (sql.startsWith("INSERT INTO org_integration_connections")) {
      const [orgId, id, providerKind, principalId, principalKind, displayName, metadataJson, ownerId] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (
        !this.connections.some(
          (c) => c.org_id === orgId && c.provider_kind === providerKind && c.provider_principal_id === principalId,
        )
      ) {
        this.connections.push({
          id,
          org_id: orgId,
          provider_kind: providerKind,
          provider_principal_id: principalId,
          principal_kind: principalKind,
          display_name: displayName,
          principal_metadata: JSON.parse(metadataJson) as Record<string, unknown>,
          health: "healthy",
          status: "active",
          current_auth_generation: null,
          owner_id: ownerId,
        });
      }
      return rowsOf([]);
    }
    if (sql.includes("FROM org_integration_connections c") && sql.includes("LEFT JOIN org_integration_grants g")) {
      return listInventory(this, params);
    }
    if (sql.includes("INSERT INTO project_integration_grant_selections")) {
      return insertSelection(this, params);
    }
    if (sql.includes("FROM org_integration_connections c") && sql.includes("JOIN org_integration_grants g")) {
      return eligibilityQuery(this, params);
    }
    if (sql.startsWith("SELECT provider_principal_id FROM org_integration_connections")) {
      const [orgId, connectionId] = params as [string, string];
      const conn = this.connections.find((row) => row.org_id === orgId && row.id === connectionId);
      return rowsOf(conn ? [{ provider_principal_id: conn.provider_principal_id }] : []);
    }
    if (sql.includes("WITH supersede_auth AS") || (sql.includes("auth_gen AS") && sql.includes("grant_gen AS"))) {
      return this.finalizeLink(params);
    }
    if (sql.includes("UPDATE org_integration_connections SET status = 'revoked'")) {
      const [orgId, connectionId] = params as [string, string];
      const conn = this.connections.find((row) => row.org_id === orgId && row.id === connectionId);
      if (conn === undefined || conn.status === "revoked") return rowsOf([]);
      conn.status = "revoked";
      return rowsOf([{ id: conn.id }]);
    }
    if (sql.includes("FROM projects") && sql.includes("project_id")) {
      const projectId = String(params.at(-1) ?? "");
      const orgId = this.projectOrg.get(projectId);
      if (orgId === undefined) return rowsOf([]);
      return rowsOf([{ project_id: projectId, org_id: orgId }]);
    }
    throw new Error(`IntegrationMemoryDb: unsupported query: ${sql.slice(0, 160)}`);
  }

  private dispatchAppEnv(sql: string, params: unknown[], scopedOrgId: string): IntegrationQueryResult {
    if (sql.startsWith("INSERT INTO project_app_env")) {
      const [
        orgId,
        id,
        projectId,
        environment,
        key,
        valueRef,
        plainValue,
        scopes,
        source,
        bindingId,
        bindingGeneration,
        secretGeneration,
        description,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string | null,
        number | null,
        number | null,
        string,
      ];
      if (orgId !== scopedOrgId || this.projectOrg.get(projectId) !== orgId) {
        throw new Error("new row violates row-level security policy for table project_app_env");
      }
      let row = this.appEnv.find(
        (item) =>
          item["org_id"] === orgId &&
          item["project_id"] === projectId &&
          item["environment"] === environment &&
          item["key"] === key,
      );
      const values = {
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        binding_id: bindingId,
        binding_generation: bindingGeneration,
        secret_generation: secretGeneration,
        description,
      };
      if (row === undefined) {
        row = { id, org_id: orgId, project_id: projectId, environment, key, ...values };
        this.appEnv.push(row);
      } else {
        Object.assign(row, values);
      }
      return rowsOf([{ ...row }]);
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM project_app_env")) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string | undefined];
      const rows = this.appEnv
        .filter(
          (row) =>
            row["org_id"] === scopedOrgId &&
            row["org_id"] === orgId &&
            row["project_id"] === projectId &&
            row["environment"] === environment &&
            (key === undefined || row["key"] === key),
        )
        .map((row) => ({ ...row }));
      return rowsOf(rows);
    }
    if (sql.startsWith("DELETE FROM project_app_env")) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string];
      const idx = this.appEnv.findIndex(
        (item) =>
          item["org_id"] === scopedOrgId &&
          item["org_id"] === orgId &&
          item["project_id"] === projectId &&
          item["environment"] === environment &&
          item["key"] === key,
      );
      if (idx < 0) return rowsOf([]);
      const [removed] = this.appEnv.splice(idx, 1);
      return rowsOf([{ id: removed?.["id"] }]);
    }
    throw new Error(`IntegrationMemoryDb: unsupported project_app_env query: ${sql.slice(0, 160)}`);
  }

  private insertOperation(sql: string, params: unknown[]): IntegrationQueryResult {
    const [orgId, id, providerKind, connectionId, operationKind, idempotencyKey, actorId] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
    ];
    const existing = this.operations.find((row) => row.org_id === orgId && row.idempotency_key === idempotencyKey);
    if (existing !== undefined && sql.includes("ON CONFLICT")) {
      return rowsOf([
        {
          id: existing.id,
          stage: existing.stage,
          status: existing.status,
          staged_secret_handle: existing.staged_secret_handle,
          connection_id: existing.connection_id,
          operation_kind: existing.operation_kind,
        },
      ]);
    }
    const op: MemoryOperation = {
      id,
      org_id: orgId,
      provider_kind: providerKind,
      connection_id: connectionId,
      operation_kind: operationKind,
      stage: "created",
      status: "pending",
      idempotency_key: idempotencyKey,
      actor_id: actorId,
      staged_secret_handle: null,
      candidate_principals: [],
      selected_principal_id: null,
      target_auth_generation: null,
      failure_classification: null,
      compensation_state: {},
    };
    this.operations.push(op);
    return rowsOf([
      {
        id: op.id,
        stage: op.stage,
        status: op.status,
        staged_secret_handle: op.staged_secret_handle,
        connection_id: op.connection_id,
        operation_kind: op.operation_kind,
      },
    ]);
  }

  private updateOperation(sql: string, params: unknown[]): IntegrationQueryResult {
    if (sql.includes("credential_staged")) {
      const [orgId, operationId, handle] = params as [string, string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.stage = "credential_staged";
        op.status = "in_progress";
        op.staged_secret_handle = handle;
      }
      return rowsOf([]);
    }
    // Match SET targets, not WHERE status IN (... awaiting_principal_selection ...).
    if (sql.includes("stage = 'awaiting_principal_selection'")) {
      const [orgId, operationId, candidatesJson, compensationJson] = params as [
        string,
        string,
        string,
        string | undefined,
      ];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.stage = "awaiting_principal_selection";
        op.status = "awaiting_principal_selection";
        op.candidate_principals = JSON.parse(candidatesJson) as unknown[];
        if (compensationJson !== undefined) {
          op.compensation_state = {
            ...op.compensation_state,
            ...(JSON.parse(compensationJson) as Record<string, unknown>),
          };
        }
      }
      return rowsOf([]);
    }
    if (sql.includes("stage = 'finalizing'")) {
      const [orgId, operationId, connectionId, generation, principalId, compensationJson] = params as [
        string,
        string,
        string,
        number,
        string,
        string,
      ];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.stage = "finalizing";
        op.status = "in_progress";
        op.connection_id = connectionId;
        op.target_auth_generation = generation;
        op.selected_principal_id = principalId;
        op.compensation_state = {
          ...op.compensation_state,
          ...(JSON.parse(compensationJson) as Record<string, unknown>),
        };
      }
      return rowsOf([]);
    }
    if (sql.includes("secret_finalize_failed") || sql.includes("failure_classification = 'secret_finalize_failed'")) {
      const [orgId, operationId, compensationJson] = params as [string, string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.failure_classification = "secret_finalize_failed";
        op.compensation_state = {
          ...op.compensation_state,
          ...(JSON.parse(compensationJson) as Record<string, unknown>),
        };
      }
      return rowsOf([]);
    }
    if (sql.includes("status = 'failed'")) {
      const [orgId, operationId, classification] = params as [string, string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.stage = "failed";
        op.status = "failed";
        op.failure_classification = classification;
      }
      return rowsOf([]);
    }
    return rowsOf([]);
  }

  private finalizeLink(params: unknown[]): IntegrationQueryResult {
    return finalizeLinkInMemory(this, params);
  }
}
