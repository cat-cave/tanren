import type pg from "pg";
import { describe, expect, it } from "vitest";
import { AppEnvironmentStore } from "../../src/engine/repositories/appEnvironment.js";
import { IntegrationConnectionsStore } from "../../src/engine/repositories/integrationConnections.js";
import { systemActor } from "../../src/engine/state/actor.js";

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
  metadata: unknown;
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

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

class IntegrationMemoryDb {
  readonly connections: ConnectionRecord[] = [];
  readonly grants: GrantRecord[] = [];
  readonly appEnv: AppEnvRecord[] = [];
  readonly projectOrg = new Map<string, string>();

  seedProject(projectId: string, orgId: string): void {
    this.projectOrg.set(projectId, orgId);
  }
}

function joinedRow(connection: ConnectionRecord, grant: GrantRecord): Record<string, unknown> {
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
  };
}

class ScopedClient {
  constructor(
    private readonly db: IntegrationMemoryDb,
    private readonly orgId: string,
  ) {}

  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const integrationResult = this.handleIntegrations(sql, params);
    if (integrationResult !== undefined) return integrationResult;
    const appEnvResult = this.handleAppEnv(sql, params);
    if (appEnvResult !== undefined) return appEnvResult;
    throw new Error(`IntegrationMemoryDb: unrecognized SQL: ${sql}`);
  }

  private handleIntegrations(sql: string, params: readonly unknown[]): QueryResult | undefined {
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
      if (orgId !== this.orgId) {
        throw new Error("new row violates row-level security policy for table org_integration_connections");
      }
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
          metadata: JSON.parse(metadata),
        };
        this.db.connections.push(connection);
      } else {
        connection.auth_kind = authKind;
        connection.credential_ref = credentialRef;
        connection.auth_generation += 1;
        connection.owner_id = ownerId;
        connection.health = "unknown";
        connection.status = "active";
        connection.metadata = JSON.parse(metadata);
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
        grant.capabilities = capabilities;
        grant.operations = operations;
        grant.provider_scopes = providerScopes;
        grant.generation += 1;
      }
      return { rows: [joinedRow(connection, grant)], rowCount: 1 };
    }
    if (/^SELECT .* FROM org_integration_connections c JOIN org_integration_grants g/u.test(sql)) {
      const [orgId, providerKind] = params as [string, string | undefined];
      const rows = this.db.connections
        .filter(
          (row) =>
            row.org_id === this.orgId &&
            row.org_id === orgId &&
            row.status === "active" &&
            (providerKind === undefined || row.provider_kind === providerKind),
        )
        .flatMap((connection) =>
          this.db.grants
            .filter(
              (grant) =>
                grant.org_id === this.orgId &&
                grant.connection_id === connection.id &&
                grant.plane === "control" &&
                grant.environment === "control" &&
                grant.status === "active",
            )
            .map((grant) => joinedRow(connection, grant)),
        );
      return { rows: providerKind === undefined ? rows : rows.slice(0, 1), rowCount: rows.length };
    }
    if (sql.startsWith("WITH revoked_grants AS ( UPDATE org_integration_grants")) {
      const [orgId, connectionId] = params as [string, string];
      const connection = this.db.connections.find(
        (row) => row.org_id === this.orgId && row.org_id === orgId && row.id === connectionId,
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

  private handleAppEnv(sql: string, params: readonly unknown[]): QueryResult | undefined {
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
      if (orgId !== this.orgId || this.db.projectOrg.get(projectId) !== orgId) {
        throw new Error("new row violates row-level security policy for table project_app_env");
      }
      if ((valueRef !== null) === (plainValue !== null)) {
        throw new Error('new row violates check constraint "project_app_env_value_xor_check"');
      }
      let row = this.db.appEnv.find(
        (candidate) =>
          candidate.org_id === orgId &&
          candidate.project_id === projectId &&
          candidate.environment === environment &&
          candidate.key === key,
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
      } else {
        Object.assign(row, values);
      }
      return { rows: [row as unknown as Record<string, unknown>], rowCount: 1 };
    }
    if (/^SELECT .* FROM project_app_env/u.test(sql)) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string | undefined];
      const rows = this.db.appEnv.filter(
        (row) =>
          row.org_id === this.orgId &&
          row.org_id === orgId &&
          row.project_id === projectId &&
          row.environment === environment &&
          (key === undefined || row.key === key),
      );
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (sql.startsWith("DELETE FROM project_app_env")) {
      const [orgId, projectId, environment, key] = params as [string, string, string, string];
      const row = this.db.appEnv.find(
        (candidate) =>
          candidate.org_id === this.orgId &&
          candidate.org_id === orgId &&
          candidate.project_id === projectId &&
          candidate.environment === environment &&
          candidate.key === key,
      );
      if (row === undefined) return { rows: [], rowCount: 0 };
      this.db.appEnv.splice(this.db.appEnv.indexOf(row), 1);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    return undefined;
  }
}

function clientForOrg(db: IntegrationMemoryDb, orgId: string): Pick<pg.Pool, "query"> {
  return new ScopedClient(db, orgId) as unknown as Pick<pg.Pool, "query">;
}

const linkInput = {
  orgId: "org_a",
  providerKind: "sentry",
  upstreamAccountId: "account-a",
  authKind: "api_key" as const,
  credentialRef: "secret://org_a/sentry",
  capabilities: ["errors"],
};

describe("IntegrationConnectionsStore conformance", () => {
  it("links explicit connection and grant records without resolving credential material", async () => {
    const db = new IntegrationMemoryDb();
    const client = clientForOrg(db, "org_a");
    const linked = await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);
    expect(linked).toMatchObject({ authGeneration: 1, grantGeneration: 1, grantStatus: "active" });
    expect(await IntegrationConnectionsStore.listControlGrants(client, "org_a", systemActor)).toHaveLength(1);
    expect(await IntegrationConnectionsStore.getControlGrant(client, "org_a", "sentry", systemActor)).toEqual({
      providerKind: "sentry",
      credentialRef: "secret://org_a/sentry",
      metadata: {},
    });
  });

  it("rotates the same account by generation and allows a second account", async () => {
    const db = new IntegrationMemoryDb();
    const client = clientForOrg(db, "org_a");
    await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);
    const rotated = await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, credentialRef: "secret://org_a/sentry/v2" },
      systemActor,
    );
    await IntegrationConnectionsStore.linkControlGrant(
      client,
      { ...linkInput, upstreamAccountId: "account-b", credentialRef: "secret://org_a/sentry/b" },
      systemActor,
    );
    expect(rotated).toMatchObject({ authGeneration: 2, grantGeneration: 2 });
    expect(await IntegrationConnectionsStore.listControlGrants(client, "org_a", systemActor)).toHaveLength(2);
  });

  it("makes off-org reads empty and revocation authoritative", async () => {
    const db = new IntegrationMemoryDb();
    const client = clientForOrg(db, "org_a");
    const linked = await IntegrationConnectionsStore.linkControlGrant(client, linkInput, systemActor);
    const other = clientForOrg(db, "org_b");
    expect(await IntegrationConnectionsStore.listControlGrants(other, "org_a", systemActor)).toEqual([]);
    expect(await IntegrationConnectionsStore.getControlGrant(other, "org_a", "sentry", systemActor)).toBeUndefined();
    expect(await IntegrationConnectionsStore.revoke(client, "org_a", linked.connectionId, systemActor)).toBe(true);
    expect(await IntegrationConnectionsStore.listControlGrants(client, "org_a", systemActor)).toEqual([]);
  });
});

describe("AppEnvironmentStore conformance", () => {
  function seeded(): { db: IntegrationMemoryDb; client: Pick<pg.Pool, "query"> } {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj_a", "org_a");
    db.seedProject("proj_b", "org_b");
    return { db, client: clientForOrg(db, "org_a") };
  }

  const base = { orgId: "org_a", projectId: "proj_a", environment: "test" as const };

  it("round-trips secret refs with explicit generations", async () => {
    const { client } = seeded();
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "RESEND_API_KEY", valueRef: "secret://proj_a/resend", secretGeneration: 1, scopes: ["test"] },
      systemActor,
    );
    const got = await AppEnvironmentStore.get(client, "org_a", "proj_a", "test", "RESEND_API_KEY", systemActor);
    expect(got).toMatchObject({ valueRef: "secret://proj_a/resend", secretGeneration: 1, plainValue: null });
  });

  it("enforces value XOR and updates only the same environment key", async () => {
    const { client } = seeded();
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "PUBLIC_URL", plainValue: "v1", scopes: ["test"] },
      systemActor,
    );
    await AppEnvironmentStore.upsert(
      client,
      { ...base, key: "PUBLIC_URL", plainValue: "v2", scopes: ["test"] },
      systemActor,
    );
    await AppEnvironmentStore.upsert(
      client,
      { ...base, environment: "production", key: "PUBLIC_URL", plainValue: "prod", scopes: ["runtime"] },
      systemActor,
    );
    expect(await AppEnvironmentStore.list(client, "org_a", "proj_a", "test", systemActor)).toHaveLength(1);
    expect(
      (await AppEnvironmentStore.get(client, "org_a", "proj_a", "test", "PUBLIC_URL", systemActor))?.plainValue,
    ).toBe("v2");
    await expect(
      AppEnvironmentStore.upsert(client, { ...base, key: "BAD", scopes: ["test"] }, systemActor),
    ).rejects.toThrow(/exactly one/u);
  });

  it("deletes in-scope rows and hides cross-org rows", async () => {
    const { db, client } = seeded();
    await AppEnvironmentStore.upsert(client, { ...base, key: "K", plainValue: "v", scopes: ["test"] }, systemActor);
    const other = clientForOrg(db, "org_b");
    expect(await AppEnvironmentStore.list(other, "org_a", "proj_a", "test", systemActor)).toEqual([]);
    expect(await AppEnvironmentStore.delete(client, "org_a", "proj_a", "test", "K", systemActor)).toBe(true);
    expect(await AppEnvironmentStore.delete(client, "org_a", "proj_a", "test", "K", systemActor)).toBe(false);
  });
});
