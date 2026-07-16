import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
  MemorySelection,
} from "./integrationMemoryTables.js";
import { finalizeLinkInMemory } from "./integrationMemoryFinalize.js";
/**
 * Structured in-memory integration tables for unit/contract tests.
 * Not a SQL-string matcher — operations are dispatched by explicit method names
 * used through IntegrationQueryClient wrappers in tests.
 */
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
    if (sql.startsWith("SELECT id, provider_kind, connection_id, operation_kind, stage, status,")) {
      const [orgId, operationId] = params as [string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      return rowsOf(op ? [op] : []);
    }
    if (sql.startsWith("SELECT id, current_auth_generation FROM org_integration_connections")) {
      const [orgId, providerKind, principalId] = params as [string, string, string];
      const conn = this.connections.find(
        (row) =>
          row.org_id === orgId && row.provider_kind === providerKind && row.provider_principal_id === principalId,
      );
      return rowsOf(conn ? [{ id: conn.id, current_auth_generation: conn.current_auth_generation }] : []);
    }
    if (sql.includes("FROM org_integration_connections c") && sql.includes("LEFT JOIN org_integration_grants g")) {
      return this.listInventory(params);
    }
    if (sql.includes("INSERT INTO project_integration_grant_selections")) {
      return this.insertSelection(params);
    }
    if (sql.includes("FROM org_integration_connections c") && sql.includes("JOIN org_integration_grants g")) {
      return this.eligibilityOrExact(sql, params);
    }
    if (sql.startsWith("SELECT provider_principal_id FROM org_integration_connections")) {
      const [orgId, connectionId] = params as [string, string];
      const conn = this.connections.find((row) => row.org_id === orgId && row.id === connectionId);
      return rowsOf(conn ? [{ provider_principal_id: conn.provider_principal_id }] : []);
    }
    if (sql.includes("WITH connection AS") && sql.includes("auth_gen AS")) {
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
    if (sql.includes("awaiting_principal_selection")) {
      const [orgId, operationId, candidatesJson] = params as [string, string, string];
      const op = this.operations.find((row) => row.org_id === orgId && row.id === operationId);
      if (op !== undefined) {
        op.stage = "awaiting_principal_selection";
        op.status = "awaiting_principal_selection";
        op.candidate_principals = JSON.parse(candidatesJson) as unknown[];
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

  private listInventory(params: unknown[]): IntegrationQueryResult {
    const [orgId] = params as [string, string | null];
    const rows = this.connections
      .filter((c) => c.org_id === orgId && c.status === "active")
      .map((c) => {
        const grant = this.grants.find(
          (g) => g.org_id === c.org_id && g.connection_id === c.id && g.plane === "control" && g.status === "active",
        );
        const ag = this.authGenerations.find(
          (row) =>
            row.org_id === c.org_id && row.connection_id === c.id && row.generation === c.current_auth_generation,
        );
        const gg =
          grant === undefined
            ? undefined
            : this.grantGenerations.find(
                (row) =>
                  row.org_id === grant.org_id &&
                  row.grant_id === grant.id &&
                  row.generation === grant.current_generation,
              );
        const selection = this.selections.find(
          (s) => s.org_id === c.org_id && s.provider_kind === c.provider_kind && s.connection_id === c.id,
        );
        const op = this.operations.filter(
          (row) =>
            row.org_id === c.org_id &&
            row.provider_kind === c.provider_kind &&
            (row.connection_id === c.id || row.connection_id === null) &&
            ["pending", "in_progress", "awaiting_principal_selection"].includes(row.status),
        );
        /* already at */
        return {
          connection_id: c.id,
          grant_id: grant?.id ?? null,
          org_id: c.org_id,
          provider_kind: c.provider_kind,
          provider_principal_id: c.provider_principal_id,
          principal_kind: c.principal_kind,
          display_name: c.display_name,
          health: c.health,
          connection_status: c.status,
          current_auth_generation: c.current_auth_generation,
          grant_generation: grant?.current_generation ?? null,
          grant_status: grant?.status ?? null,
          auth_expires_at: ag?.expires_at ?? null,
          provider_scopes: gg?.provider_scopes ?? [],
          operation_id: op?.id ?? null,
          operation_stage: op?.stage ?? null,
          operation_status: op?.status ?? null,
          selected_for_project: selection !== undefined,
        };
      });
    return rowsOf(rows);
  }

  private insertSelection(params: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, providerKind, connectionId, grantId, authGeneration, grantGeneration, selectedBy] =
      params as [string, string, string, string, string, number, number, string];
    const conn = this.connections.find(
      (c) =>
        c.org_id === orgId &&
        c.provider_kind === providerKind &&
        c.id === connectionId &&
        c.current_auth_generation === authGeneration,
    );
    const grant = this.grants.find(
      (g) =>
        g.org_id === orgId &&
        g.connection_id === connectionId &&
        g.id === grantId &&
        g.current_generation === grantGeneration,
    );
    if (conn === undefined || grant === undefined) return rowsOf([]);
    this.selections = this.selections.filter(
      (s) => !(s.org_id === orgId && s.project_id === projectId && s.provider_kind === providerKind),
    );
    this.selections.push({
      org_id: orgId,
      project_id: projectId,
      provider_kind: providerKind,
      connection_id: connectionId,
      auth_generation: authGeneration,
      grant_id: grantId,
      grant_generation: grantGeneration,
      selected_by: selectedBy,
    });
    return rowsOf([
      {
        connection_id: connectionId,
        grant_id: grantId,
        auth_generation: authGeneration,
        grant_generation: grantGeneration,
      },
    ]);
  }

  private eligibilityOrExact(sql: string, params: unknown[]): IntegrationQueryResult {
    if (sql.includes("c.current_auth_generation") && params.length >= 4 && typeof params[2] === "string") {
      // resolveExactControlGrant style
      const [orgId, providerKind, connectionId, grantId] = params as [string, string, string, string];
      const c = this.connections.find(
        (row) => row.org_id === orgId && row.provider_kind === providerKind && row.id === connectionId,
      );
      const g = this.grants.find(
        (row) => row.org_id === orgId && row.connection_id === connectionId && row.id === grantId,
      );
      if (c === undefined || g === undefined) return rowsOf([]);
      const ag = this.authGenerations.find(
        (row) => row.connection_id === c.id && row.generation === c.current_auth_generation && row.status === "active",
      );
      const gg = this.grantGenerations.find(
        (row) => row.grant_id === g.id && row.generation === g.current_generation && row.status === "active",
      );
      if (ag === undefined || gg === undefined) return rowsOf([]);
      return rowsOf([
        {
          connection_id: c.id,
          provider_kind: c.provider_kind,
          provider_principal_id: c.provider_principal_id,
          principal_metadata: c.principal_metadata,
          current_auth_generation: c.current_auth_generation,
          grant_id: g.id,
          grant_generation: g.current_generation,
          credential_ref: ag.credential_ref,
          policy_revision: gg.policy_revision,
          consent_revision: gg.consent_revision,
          capabilities: gg.capabilities,
          operations: gg.operations,
        },
      ]);
    }
    // ELIGIBILITY_SQL
    const [orgId, projectId, providerKind] = params as [string, string, string];
    const rows = [];
    for (const c of this.connections.filter((row) => row.org_id === orgId && row.provider_kind === providerKind)) {
      for (const g of this.grants.filter(
        (row) => row.org_id === orgId && row.connection_id === c.id && row.plane === "control",
      )) {
        const ag = this.authGenerations.find(
          (row) => row.connection_id === c.id && row.generation === c.current_auth_generation,
        );
        const gg = this.grantGenerations.find(
          (row) => row.grant_id === g.id && row.generation === g.current_generation,
        );
        const s = this.selections.find(
          (row) => row.org_id === orgId && row.project_id === projectId && row.provider_kind === providerKind,
        );
        rows.push({
          connection_id: c.id,
          provider_kind: c.provider_kind,
          provider_principal_id: c.provider_principal_id,
          display_name: c.display_name,
          principal_metadata: c.principal_metadata,
          connection_health: c.health,
          connection_status: c.status,
          current_auth_generation: c.current_auth_generation,
          grant_id: g.id,
          grant_current_generation: g.current_generation,
          grant_status: g.status,
          plane: g.plane,
          environment: g.environment,
          credential_ref: ag?.credential_ref ?? null,
          auth_expires_at: ag?.expires_at ?? null,
          auth_status: ag?.status ?? null,
          capabilities: gg?.capabilities ?? null,
          operations: gg?.operations ?? null,
          provider_scopes: gg?.provider_scopes ?? null,
          resource_constraints: {},
          policy_revision: gg?.policy_revision ?? null,
          consent_revision: gg?.consent_revision ?? null,
          grant_expires_at: gg?.expires_at ?? null,
          grant_generation_status: gg?.status ?? null,
          selected_auth_generation: s?.auth_generation ?? null,
          selected_grant_generation: s?.grant_generation ?? null,
          selected_connection_id: s?.connection_id ?? null,
          selected_grant_id: s?.grant_id ?? null,
        });
      }
    }
    return rowsOf(rows);
  }

  private finalizeLink(params: unknown[]): IntegrationQueryResult {
    return finalizeLinkInMemory(this, params);
  }
}

function rowsOf(rows: unknown[]): IntegrationQueryResult {
  return { rows, rowCount: rows.length };
}
