import type { IntegrationQueryClient, IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";

interface ConnectionRecord {
  id: string;
  org_id: string;
  provider_kind: string;
  upstream_account_id: string;
  auth_kind: string;
  credential_ref: string;
  auth_generation: number;
  owner_id: string;
  health: string;
  status: string;
  metadata: Record<string, unknown>;
}

interface GrantRecord {
  id: string;
  org_id: string;
  connection_id: string;
  plane: string;
  environment: string;
  capabilities: string[];
  operations: string[];
  provider_scopes: string[];
  generation: number;
  status: string;
}

interface SelectionRecord {
  org_id: string;
  project_id: string;
  provider_kind: string;
  connection_id: string;
  grant_id: string;
  selected_by: string;
}

interface AppEnvRecord {
  id: string;
  org_id: string;
  project_id: string;
  environment: string;
  key: string;
  value_ref: string | null;
  plain_value: string | null;
  scopes: string[];
  source: string;
  binding_id: string | null;
  binding_generation: number | null;
  secret_generation: number | null;
  description: string;
}

function joinedRow(
  connection: ConnectionRecord,
  grant: GrantRecord,
  selectedForProject = false,
): Record<string, unknown> {
  return {
    connection_id: connection.id,
    grant_id: grant.id,
    org_id: connection.org_id,
    provider_kind: connection.provider_kind,
    upstream_account_id: connection.upstream_account_id,
    auth_kind: connection.auth_kind,
    credential_ref: connection.credential_ref,
    auth_generation: connection.auth_generation,
    owner_id: connection.owner_id,
    health: connection.health,
    connection_status: connection.status,
    metadata: connection.metadata,
    plane: grant.plane,
    environment: grant.environment,
    capabilities: grant.capabilities,
    operations: grant.operations,
    provider_scopes: grant.provider_scopes,
    grant_generation: grant.generation,
    grant_status: grant.status,
    selected_for_project: selectedForProject,
  };
}

export class IntegrationMemoryDb {
  readonly connections: ConnectionRecord[] = [];
  readonly grants: GrantRecord[] = [];
  readonly selections: SelectionRecord[] = [];
  readonly appEnv: AppEnvRecord[] = [];
  readonly projectOrg = new Map<string, string>();

  seedProject(projectId: string, orgId: string): void {
    this.projectOrg.set(projectId, orgId);
  }

  clientForOrg(orgId: string): IntegrationQueryClient {
    return new ScopedIntegrationClient(this, orgId);
  }
}

class ScopedIntegrationClient implements IntegrationQueryClient {
  constructor(
    private readonly db: IntegrationMemoryDb,
    private readonly scopedOrgId: string,
  ) {}

  async query(rawSql: string, params: unknown[] = []): Promise<IntegrationQueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const integration = this.integrations(sql, params);
    if (integration !== undefined) return integration;
    const appEnv = this.environment(sql, params);
    if (appEnv !== undefined) return appEnv;
    throw new Error(`IntegrationMemoryDb: unrecognized SQL: ${sql}`);
  }

  private integrations(sql: string, params: unknown[]): IntegrationQueryResult | undefined {
    if (sql.startsWith("WITH connection AS ( INSERT INTO org_integration_connections")) {
      const [
        orgId,
        connectionId,
        providerKind,
        upstreamAccountId,
        authKind,
        credentialRef,
        ownerId,
        metadata,
        grantId,
        capabilities,
        operations,
        providerScopes,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string[],
        string[],
        string[],
      ];
      this.assertOrg(orgId);
      let connection = this.db.connections.find(
        (row) =>
          row.org_id === orgId && row.provider_kind === providerKind && row.upstream_account_id === upstreamAccountId,
      );
      if (connection === undefined) {
        connection = {
          id: connectionId,
          org_id: orgId,
          provider_kind: providerKind,
          upstream_account_id: upstreamAccountId,
          auth_kind: authKind,
          credential_ref: credentialRef,
          auth_generation: 1,
          owner_id: ownerId,
          health: "unknown",
          status: "active",
          metadata: JSON.parse(metadata) as Record<string, unknown>,
        };
        this.db.connections.push(connection);
      } else {
        Object.assign(connection, {
          auth_kind: authKind,
          credential_ref: credentialRef,
          auth_generation: connection.auth_generation + 1,
          owner_id: ownerId,
          health: "unknown",
          status: "active",
          metadata: JSON.parse(metadata) as Record<string, unknown>,
        });
      }
      let grant = this.db.grants.find(
        (row) =>
          row.org_id === orgId &&
          row.connection_id === connection.id &&
          row.plane === "control" &&
          row.environment === "control" &&
          row.status === "active",
      );
      if (grant === undefined) {
        grant = {
          id: grantId,
          org_id: orgId,
          connection_id: connection.id,
          plane: "control",
          environment: "control",
          capabilities,
          operations,
          provider_scopes: providerScopes,
          generation: 1,
          status: "active",
        };
        this.db.grants.push(grant);
      } else {
        Object.assign(grant, {
          capabilities,
          operations,
          provider_scopes: providerScopes,
          generation: grant.generation + 1,
        });
      }
      return { rows: [joinedRow(connection, grant)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT connection_id, grant_id FROM project_integration_grant_selections")) {
      const [orgId, projectId, providerKind] = params as [string, string, string];
      const row = this.db.selections.find(
        (item) =>
          item.org_id === this.scopedOrgId &&
          item.org_id === orgId &&
          item.project_id === projectId &&
          item.provider_kind === providerKind,
      );
      return {
        rows: row === undefined ? [] : [{ connection_id: row.connection_id, grant_id: row.grant_id }],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM org_integration_connections c")) {
      const [orgId, projectId] = params as [string, string | null];
      const rows = this.db.connections
        .filter((row) => row.org_id === this.scopedOrgId && row.org_id === orgId && row.status === "active")
        .flatMap((connection) =>
          this.db.grants
            .filter(
              (grant) =>
                grant.org_id === connection.org_id &&
                grant.connection_id === connection.id &&
                grant.plane === "control" &&
                grant.environment === "control" &&
                grant.status === "active",
            )
            .map((grant) => {
              const selected = this.db.selections.some(
                (item) =>
                  item.org_id === orgId &&
                  item.project_id === projectId &&
                  item.provider_kind === connection.provider_kind &&
                  item.connection_id === connection.id &&
                  item.grant_id === grant.id,
              );
              return joinedRow(connection, grant, selected);
            }),
        );
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO project_integration_grant_selections")) {
      const [orgId, projectId, providerKind, connectionId, grantId, selectedBy] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      this.assertOrg(orgId);
      const connection = this.db.connections.find(
        (row) =>
          row.org_id === orgId &&
          row.id === connectionId &&
          row.provider_kind === providerKind &&
          row.status === "active",
      );
      const grant = this.db.grants.find(
        (row) =>
          row.org_id === orgId && row.id === grantId && row.connection_id === connectionId && row.status === "active",
      );
      if (this.db.projectOrg.get(projectId) !== orgId || connection === undefined || grant === undefined) {
        return { rows: [], rowCount: 0 };
      }
      const existing = this.db.selections.find(
        (row) => row.org_id === orgId && row.project_id === projectId && row.provider_kind === providerKind,
      );
      const selected = {
        org_id: orgId,
        project_id: projectId,
        provider_kind: providerKind,
        connection_id: connectionId,
        grant_id: grantId,
        selected_by: selectedBy,
      };
      if (existing === undefined) this.db.selections.push(selected);
      else Object.assign(existing, selected);
      return { rows: [{ connection_id: connectionId, grant_id: grantId }], rowCount: 1 };
    }
    if (sql.startsWith("WITH revoked_grants AS ( UPDATE org_integration_grants")) {
      const [orgId, connectionId] = params as [string, string];
      const connection = this.db.connections.find(
        (row) => row.org_id === this.scopedOrgId && row.org_id === orgId && row.id === connectionId,
      );
      if (connection === undefined || connection.status === "revoked") return { rows: [], rowCount: 0 };
      connection.status = "revoked";
      for (const grant of this.db.grants) {
        if (grant.org_id === orgId && grant.connection_id === connectionId) grant.status = "revoked";
      }
      return { rows: [{ id: connection.id }], rowCount: 1 };
    }
    return undefined;
  }

  private environment(sql: string, params: unknown[]): IntegrationQueryResult | undefined {
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
      if (orgId !== this.scopedOrgId || this.db.projectOrg.get(projectId) !== orgId) {
        throw new Error("new row violates row-level security policy for table project_app_env");
      }
      let row = this.db.appEnv.find(
        (item) =>
          item.org_id === orgId &&
          item.project_id === projectId &&
          item.environment === environment &&
          item.key === key,
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
        this.db.appEnv.push(row);
      } else Object.assign(row, values);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM project_app_env")) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string | undefined];
      const rows = this.db.appEnv
        .filter(
          (row) =>
            row.org_id === this.scopedOrgId &&
            row.org_id === orgId &&
            row.project_id === projectId &&
            row.environment === environment &&
            (key === undefined || row.key === key),
        )
        .map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("DELETE FROM project_app_env")) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string];
      const row = this.db.appEnv.find(
        (item) =>
          item.org_id === this.scopedOrgId &&
          item.org_id === orgId &&
          item.project_id === projectId &&
          item.environment === environment &&
          item.key === key,
      );
      if (row === undefined) return { rows: [], rowCount: 0 };
      this.db.appEnv.splice(this.db.appEnv.indexOf(row), 1);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    return undefined;
  }

  private assertOrg(orgId: string): void {
    if (orgId !== this.scopedOrgId) {
      throw new Error("new row violates row-level security policy for integration lifecycle table");
    }
  }
}
