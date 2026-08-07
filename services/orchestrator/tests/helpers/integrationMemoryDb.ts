import type {
  MemoryAuthGeneration,
  MemoryConnection,
  MemoryGrant,
  MemoryGrantGeneration,
  MemoryOperation,
  MemorySelection,
} from "./integrationMemoryTables.js";
import { finalizeLinkInMemory } from "./integrationMemoryFinalize.js";
import { dispatchActivateSql } from "./integrationMemoryActivate.js";
import { dispatchOperationSql } from "./integrationMemoryOperations.js";
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

    const operation = dispatchOperationSql(this.operations, sql, params);
    if (operation !== null) return operation;
    if (
      sql.startsWith("SELECT id, current_auth_generation") ||
      sql.startsWith("SELECT id, current_auth_generation, status") ||
      sql.startsWith("SELECT id, provider_principal_id, current_auth_generation")
    ) {
      const [orgId, providerKind, principalOrConnectionId] = params as [string, string, string];
      const byConnection = sql.includes("provider_principal_id, current_auth_generation");
      const activeOnly = sql.includes("status = 'active'");
      const conn = this.connections.find(
        (row) =>
          row.org_id === orgId &&
          row.provider_kind === providerKind &&
          (byConnection ? row.id : row.provider_principal_id) === principalOrConnectionId &&
          (!activeOnly || row.status === "active"),
      );
      return rowsOf(
        conn
          ? [
              {
                id: conn.id,
                provider_principal_id: conn.provider_principal_id,
                current_auth_generation: conn.current_auth_generation,
                status: conn.status,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith("SELECT id FROM org_integration_connections")) {
      const [orgId, providerKind, principalId] = params as [string, string, string];
      const conn = this.connections.find(
        (row) =>
          row.org_id === orgId &&
          row.provider_kind === providerKind &&
          row.provider_principal_id === principalId &&
          row.status === "active",
      );
      return rowsOf(conn ? [{ id: conn.id }] : []);
    }
    if (sql.startsWith("SELECT provider_principal_id, principal_kind, status")) {
      const [orgId, providerKind, connectionId] = params as [string, string, string];
      const conn = this.connections.find(
        (row) => row.org_id === orgId && row.provider_kind === providerKind && row.id === connectionId,
      );
      return rowsOf(
        conn
          ? [
              {
                provider_principal_id: conn.provider_principal_id,
                principal_kind: conn.principal_kind,
                status: conn.status,
              },
            ]
          : [],
      );
    }
    if (sql.startsWith("SELECT principal_metadata FROM org_integration_connections")) {
      const [orgId, providerKind, connectionId] = params as [string, string, string];
      const conn = this.connections.find(
        (row) =>
          row.org_id === orgId &&
          row.provider_kind === providerKind &&
          row.id === connectionId &&
          row.status === "active",
      );
      return rowsOf(conn ? [{ principal_metadata: conn.principal_metadata }] : []);
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
    if (sql.startsWith("SELECT current_generation, status FROM org_integration_grants")) {
      const [orgId, providerKind, connectionId, grantId] = params as [string, string, string, string];
      const grant = this.grants.find(
        (row) =>
          row.org_id === orgId &&
          row.provider_kind === providerKind &&
          row.connection_id === connectionId &&
          row.id === grantId,
      );
      return rowsOf(grant ? [{ current_generation: grant.current_generation, status: grant.status }] : []);
    }
    if (sql.startsWith("SELECT id, current_generation")) {
      const [orgId, providerKind, connectionId] = params as [string, string, string];
      const activeOnly = sql.includes("status = 'active'");
      const grant = this.grants.find(
        (row) =>
          row.org_id === orgId &&
          row.provider_kind === providerKind &&
          row.connection_id === connectionId &&
          row.plane === "control" &&
          row.environment === "control" &&
          (!activeOnly || row.status === "active"),
      );
      return rowsOf(
        grant ? [{ id: grant.id, current_generation: grant.current_generation, status: grant.status }] : [],
      );
    }
    if (sql.startsWith("SELECT c.id AS connection_id, c.display_name")) {
      const [orgId, connectionId, providerKind, authGeneration, grantId, grantGeneration] = params as [
        string,
        string,
        string,
        number,
        string,
        number,
      ];
      const conn = this.connections.find(
        (row) => row.org_id === orgId && row.id === connectionId && row.provider_kind === providerKind,
      );
      const grant = this.grants.find(
        (row) => row.org_id === orgId && row.connection_id === connectionId && row.id === grantId,
      );
      const auth = this.authGenerations.find(
        (row) => row.org_id === orgId && row.connection_id === connectionId && row.generation === authGeneration,
      );
      const grantGen = this.grantGenerations.find(
        (row) => row.org_id === orgId && row.grant_id === grantId && row.generation === grantGeneration,
      );
      return rowsOf(
        conn !== undefined && grant !== undefined && auth !== undefined && grantGen !== undefined
          ? [
              {
                connection_id: conn.id,
                display_name: conn.display_name,
                auth_generation: auth.generation,
                grant_id: grant.id,
                grant_generation: grantGen.generation,
              },
            ]
          : [],
      );
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
    const activated = dispatchActivateSql(this, sql, params);
    if (activated !== null) return activated;
    if (sql.includes("WITH supersede_auth AS") || (sql.includes("auth_gen AS") && sql.includes("grant_gen AS"))) {
      return this.finalizeLink(params);
    }
    if (sql.includes("UPDATE org_integration_connections SET status = 'revoked'")) {
      const [orgId, connectionId] = params as [string, string];
      const conn = this.connections.find((row) => row.org_id === orgId && row.id === connectionId);
      if (conn === undefined || conn.status === "revoked") return rowsOf([]);
      conn.status = "revoked";
      for (const grant of this.grants.filter((row) => row.org_id === orgId && row.connection_id === connectionId)) {
        grant.status = "revoked";
      }
      for (const generation of this.grantGenerations.filter(
        (row) => row.org_id === orgId && row.connection_id === connectionId && row.status === "active",
      )) {
        generation.status = "revoked";
      }
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

  private finalizeLink(params: unknown[]): IntegrationQueryResult {
    return finalizeLinkInMemory(this, params);
  }
}
