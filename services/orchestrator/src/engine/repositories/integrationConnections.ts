import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { oneOf } from "../data/pgRows.js";
import type { ActorRef } from "../state/actor.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const INTEGRATION_CONNECTION_HEALTH = ["unknown", "healthy", "degraded", "invalid"] as const;
export type IntegrationConnectionHealth = (typeof INTEGRATION_CONNECTION_HEALTH)[number];

export const INTEGRATION_CONNECTION_STATUSES = ["active", "revoked"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

export const INTEGRATION_GRANT_STATUSES = ["pending", "active", "expired", "revoked"] as const;
export type IntegrationGrantStatus = (typeof INTEGRATION_GRANT_STATUSES)[number];

export interface IntegrationConnectionGrant {
  connectionId: string;
  grantId: string;
  orgId: string;
  providerKind: string;
  upstreamAccountId: string;
  authKind: string;
  credentialRef: string;
  authGeneration: number;
  ownerId: string;
  health: IntegrationConnectionHealth;
  connectionStatus: IntegrationConnectionStatus;
  metadata: Record<string, unknown>;
  plane: "control";
  environment: "control";
  capabilities: string[];
  operations: string[];
  providerScopes: string[];
  grantGeneration: number;
  grantStatus: IntegrationGrantStatus;
}

export interface LinkControlIntegrationInput {
  orgId: string;
  providerKind: string;
  upstreamAccountId: string;
  authKind: "api_key" | "oauth2" | "bot_token" | "webhook" | "workload_identity";
  credentialRef: string;
  metadata?: Record<string, unknown>;
  capabilities: string[];
  operations?: string[];
  providerScopes?: string[];
  policyRevision?: string;
  consentRevision?: string;
}

interface ConnectionGrantRow {
  connection_id: string;
  grant_id: string;
  org_id: string;
  provider_kind: string;
  upstream_account_id: string;
  auth_kind: string;
  credential_ref: string;
  auth_generation: number;
  owner_id: string;
  health: string;
  connection_status: string;
  metadata: unknown;
  plane: string;
  environment: string;
  capabilities: string[] | null;
  operations: string[] | null;
  provider_scopes: string[] | null;
  grant_generation: number;
  grant_status: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).catch({}).parse(value);
}

function mapRow(row: ConnectionGrantRow): IntegrationConnectionGrant {
  if (row.plane !== "control" || row.environment !== "control") {
    throw new Error(`control integration query returned ${row.plane}/${row.environment}`);
  }
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id,
    orgId: row.org_id,
    providerKind: row.provider_kind,
    upstreamAccountId: row.upstream_account_id,
    authKind: row.auth_kind,
    credentialRef: row.credential_ref,
    authGeneration: row.auth_generation,
    ownerId: row.owner_id,
    health: oneOf(row.health, INTEGRATION_CONNECTION_HEALTH, "org_integration_connections.health"),
    connectionStatus: oneOf(
      row.connection_status,
      INTEGRATION_CONNECTION_STATUSES,
      "org_integration_connections.status",
    ),
    metadata: asRecord(row.metadata),
    plane: "control",
    environment: "control",
    capabilities: row.capabilities ?? [],
    operations: row.operations ?? [],
    providerScopes: row.provider_scopes ?? [],
    grantGeneration: row.grant_generation,
    grantStatus: oneOf(row.grant_status, INTEGRATION_GRANT_STATUSES, "org_integration_grants.status"),
  };
}

const SELECT_COLUMNS = `
  c.id AS connection_id,
  g.id AS grant_id,
  c.org_id,
  c.provider_kind,
  c.upstream_account_id,
  c.auth_kind,
  c.credential_ref,
  c.auth_generation,
  c.owner_id,
  c.health,
  c.status AS connection_status,
  c.metadata,
  g.plane,
  g.environment,
  g.capabilities,
  g.operations,
  g.provider_scopes,
  g.generation AS grant_generation,
  g.status AS grant_status`;

export const IntegrationConnectionsStore = {
  /**
   * Link or rotate one control-plane connection and its explicit grant in one SQL
   * statement. The credential value has already been placed in the secret store;
   * only its opaque ref is persisted here.
   */
  async linkControlGrant(
    client: QueryClient,
    input: LinkControlIntegrationInput,
    actor: ActorRef,
  ): Promise<IntegrationConnectionGrant> {
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const ownerId = actor.id ?? actor.label ?? actor.kind;
    const result = await client.query<ConnectionGrantRow>(
      `WITH connection AS (
         INSERT INTO org_integration_connections
           (org_id, id, provider_kind, upstream_account_id, auth_kind, credential_ref,
            auth_generation, owner_id, health, metadata, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'unknown', $8::jsonb, 'active', now())
         ON CONFLICT (org_id, provider_kind, upstream_account_id) DO UPDATE SET
           auth_kind = EXCLUDED.auth_kind,
           credential_ref = EXCLUDED.credential_ref,
           auth_generation = org_integration_connections.auth_generation + 1,
           owner_id = EXCLUDED.owner_id,
           health = 'unknown',
           metadata = EXCLUDED.metadata,
           status = 'active',
           updated_at = now()
         RETURNING *
       ), control_grant AS (
         INSERT INTO org_integration_grants
           (org_id, id, connection_id, plane, environment, capabilities, operations,
            provider_scopes, resource_constraints, policy_revision, consent_revision,
            generation, status, updated_at)
         SELECT $1, $9, connection.id, 'control', 'control', $10::text[], $11::text[],
                $12::text[], '{}'::jsonb, $13, $14, 1, 'active', now()
         FROM connection
         ON CONFLICT (org_id, connection_id, plane, environment) WHERE status = 'active'
         DO UPDATE SET
           capabilities = EXCLUDED.capabilities,
           operations = EXCLUDED.operations,
           provider_scopes = EXCLUDED.provider_scopes,
           policy_revision = EXCLUDED.policy_revision,
           consent_revision = EXCLUDED.consent_revision,
           generation = org_integration_grants.generation + 1,
           updated_at = now()
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS}
       FROM connection c
       JOIN control_grant g ON g.org_id = c.org_id AND g.connection_id = c.id`,
      [
        input.orgId,
        connectionId,
        input.providerKind,
        input.upstreamAccountId,
        input.authKind,
        input.credentialRef,
        ownerId,
        JSON.stringify(input.metadata ?? {}),
        grantId,
        input.capabilities,
        input.operations ?? input.capabilities,
        input.providerScopes ?? [],
        input.policyRevision ?? "manual-link.v1",
        input.consentRevision ?? "manual-link.v1",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`control integration link returned no row for (${input.orgId}, ${input.providerKind})`);
    }
    return mapRow(row);
  },

  async listControlGrants(client: QueryClient, orgId: string, _actor: ActorRef): Promise<IntegrationConnectionGrant[]> {
    const result = await client.query<ConnectionGrantRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM org_integration_connections c
       JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id
       WHERE c.org_id = $1 AND c.status = 'active'
         AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
       ORDER BY c.provider_kind, c.upstream_account_id`,
      [orgId],
    );
    return result.rows.map(mapRow);
  },

  async getControlGrant(
    client: QueryClient,
    orgId: string,
    providerKind: string,
    _actor: ActorRef,
  ): Promise<OrgGrant | undefined> {
    const result = await client.query<ConnectionGrantRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM org_integration_connections c
       JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id
       WHERE c.org_id = $1 AND c.provider_kind = $2 AND c.status = 'active'
         AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
       ORDER BY c.updated_at DESC
       LIMIT 1`,
      [orgId, providerKind],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const linked = mapRow(row);
    return {
      providerKind: linked.providerKind,
      credentialRef: linked.credentialRef,
      metadata: linked.metadata,
    };
  },

  async revoke(client: QueryClient, orgId: string, connectionId: string, _actor: ActorRef): Promise<boolean> {
    const result = await client.query(
      `WITH revoked_grants AS (
         UPDATE org_integration_grants
         SET status = 'revoked', revoked_at = now(), updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status <> 'revoked'
       )
       UPDATE org_integration_connections
       SET status = 'revoked', updated_at = now()
       WHERE org_id = $1 AND id = $2 AND status <> 'revoked'
       RETURNING id`,
      [orgId, connectionId],
    );
    return (result.rowCount ?? 0) > 0;
  },
} as const;
