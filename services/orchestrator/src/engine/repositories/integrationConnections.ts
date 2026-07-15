import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import type { ActorRef } from "../state/actor.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export const INTEGRATION_CONNECTION_HEALTH = ["unknown", "healthy", "degraded", "invalid"] as const;
export type IntegrationConnectionHealth = (typeof INTEGRATION_CONNECTION_HEALTH)[number];

export const INTEGRATION_CONNECTION_STATUSES = ["active", "revoked"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

export const INTEGRATION_GRANT_STATUSES = ["pending", "active", "expired", "revoked"] as const;
export type IntegrationGrantStatus = (typeof INTEGRATION_GRANT_STATUSES)[number];

const ConnectionGrantRow = z.object({
  connection_id: z.string(),
  grant_id: z.string(),
  org_id: z.string(),
  provider_kind: z.string(),
  upstream_account_id: z.string(),
  auth_kind: z.string(),
  credential_ref: z.string(),
  auth_generation: z.coerce.number().int().positive(),
  owner_id: z.string(),
  health: z.enum(INTEGRATION_CONNECTION_HEALTH),
  connection_status: z.enum(INTEGRATION_CONNECTION_STATUSES),
  metadata: z.record(z.string(), z.unknown()),
  plane: z.literal("control"),
  environment: z.literal("control"),
  capabilities: z.array(z.string()).nullable(),
  operations: z.array(z.string()).nullable(),
  provider_scopes: z.array(z.string()).nullable(),
  grant_generation: z.coerce.number().int().positive(),
  grant_status: z.enum(INTEGRATION_GRANT_STATUSES),
  selected_for_project: z.boolean().optional().default(false),
});
type ConnectionGrantRow = z.infer<typeof ConnectionGrantRow>;

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
  selectedForProject: boolean;
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

export interface ControlGrantCandidate {
  connectionId: string;
  grantId: string;
  providerKind: string;
  upstreamAccountId: string;
  health: IntegrationConnectionHealth;
  authGeneration: number;
  grantGeneration: number;
}

export type ControlGrantResolution =
  | { status: "selected"; grant: OrgGrant }
  | { status: "not_linked" }
  | {
      status: "selection_required";
      reason: "selection_missing" | "multiple_eligible" | "selected_grant_unavailable";
      candidates: ControlGrantCandidate[];
    };

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

function mapRow(value: unknown): IntegrationConnectionGrant {
  const row = ConnectionGrantRow.parse(value);
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
    health: row.health,
    connectionStatus: row.connection_status,
    metadata: row.metadata,
    plane: row.plane,
    environment: row.environment,
    capabilities: row.capabilities ?? [],
    operations: row.operations ?? [],
    providerScopes: row.provider_scopes ?? [],
    grantGeneration: row.grant_generation,
    grantStatus: row.grant_status,
    selectedForProject: row.selected_for_project,
  };
}

function asGrant(linked: IntegrationConnectionGrant): OrgGrant {
  return {
    connectionId: linked.connectionId,
    grantId: linked.grantId,
    providerKind: linked.providerKind,
    upstreamAccountId: linked.upstreamAccountId,
    credentialRef: linked.credentialRef,
    authGeneration: linked.authGeneration,
    grantGeneration: linked.grantGeneration,
    metadata: linked.metadata,
  };
}

function asCandidate(linked: IntegrationConnectionGrant): ControlGrantCandidate {
  return {
    connectionId: linked.connectionId,
    grantId: linked.grantId,
    providerKind: linked.providerKind,
    upstreamAccountId: linked.upstreamAccountId,
    health: linked.health,
    authGeneration: linked.authGeneration,
    grantGeneration: linked.grantGeneration,
  };
}

/** Stable per-account ref: rotation reuses one slot; sibling accounts never collide. */
export function credentialRefForIntegrationAccount(
  orgId: string,
  providerKind: string,
  upstreamAccountId: string,
): string {
  const accountKey = createHash("sha256").update(providerKind).update("\0").update(upstreamAccountId).digest("hex");
  return `secret://org/${encodeURIComponent(orgId)}/integration/${encodeURIComponent(providerKind)}/account/${accountKey}/token`;
}

export const IntegrationConnectionsStore = {
  async linkControlGrant(
    client: IntegrationQueryClient,
    input: LinkControlIntegrationInput,
    actor: ActorRef,
  ): Promise<IntegrationConnectionGrant> {
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const ownerId = actor.id ?? actor.label ?? actor.kind;
    const result = await client.query(
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
           health = 'unknown', metadata = EXCLUDED.metadata, status = 'active', updated_at = now()
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
         DO UPDATE SET capabilities = EXCLUDED.capabilities, operations = EXCLUDED.operations,
           provider_scopes = EXCLUDED.provider_scopes, policy_revision = EXCLUDED.policy_revision,
           consent_revision = EXCLUDED.consent_revision,
           generation = org_integration_grants.generation + 1, updated_at = now()
         RETURNING *
       )
       SELECT ${SELECT_COLUMNS}, false AS selected_for_project
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

  async listControlGrants(
    client: IntegrationQueryClient,
    orgId: string,
    _actor: ActorRef,
    projectId?: string,
  ): Promise<IntegrationConnectionGrant[]> {
    const result = await client.query(
      `SELECT ${SELECT_COLUMNS},
         (s.connection_id = c.id AND s.grant_id = g.id) AS selected_for_project
       FROM org_integration_connections c
       JOIN org_integration_grants g ON g.org_id = c.org_id AND g.connection_id = c.id
       LEFT JOIN project_integration_grant_selections s
         ON s.org_id = c.org_id AND s.project_id = $2 AND s.provider_kind = c.provider_kind
       WHERE c.org_id = $1 AND c.status = 'active'
         AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
       ORDER BY c.provider_kind, c.upstream_account_id`,
      [orgId, projectId ?? null],
    );
    return result.rows.map(mapRow);
  },

  async resolveControlGrant(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    providerKind: string,
    actor: ActorRef,
  ): Promise<ControlGrantResolution> {
    const selection = await client.query(
      `SELECT connection_id, grant_id FROM project_integration_grant_selections
       WHERE org_id = $1 AND project_id = $2 AND provider_kind = $3`,
      [orgId, projectId, providerKind],
    );
    const eligible = (await this.listControlGrants(client, orgId, actor, projectId)).filter(
      (row) => row.providerKind === providerKind,
    );
    if (eligible.length === 0 && selection.rows[0] === undefined) return { status: "not_linked" };

    const selected = eligible.find((row) => row.selectedForProject);
    if (selected !== undefined) return { status: "selected", grant: asGrant(selected) };

    const reason =
      selection.rows[0] === undefined
        ? eligible.length > 1
          ? "multiple_eligible"
          : "selection_missing"
        : "selected_grant_unavailable";
    return {
      status: "selection_required",
      reason,
      candidates: eligible.map((row) => asCandidate(row)),
    };
  },

  /** Resolve an exact account before a project exists (greenfield compensation). */
  async getControlGrantByIds(
    client: IntegrationQueryClient,
    orgId: string,
    providerKind: string,
    connectionId: string,
    grantId: string,
    actor: ActorRef,
  ): Promise<OrgGrant | undefined> {
    const eligible = await this.listControlGrants(client, orgId, actor);
    const linked = eligible.find(
      (row) => row.providerKind === providerKind && row.connectionId === connectionId && row.grantId === grantId,
    );
    return linked === undefined ? undefined : asGrant(linked);
  },

  async selectControlGrant(
    client: IntegrationQueryClient,
    input: { orgId: string; projectId: string; providerKind: string; connectionId: string; grantId: string },
    actor: ActorRef,
  ): Promise<OrgGrant | undefined> {
    const selectedBy = actor.id ?? actor.label ?? actor.kind;
    const result = await client.query(
      `INSERT INTO project_integration_grant_selections
         (org_id, project_id, provider_kind, connection_id, grant_id, selected_by, selected_at, updated_at)
       SELECT p.org_id, p.project_id, c.provider_kind, c.id, g.id, $6, now(), now()
       FROM projects p
       JOIN org_integration_connections c
         ON c.org_id = p.org_id AND c.provider_kind = $3 AND c.id = $4 AND c.status = 'active'
       JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id AND g.id = $5
        AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
       WHERE p.org_id = $1 AND p.project_id = $2
       ON CONFLICT (org_id, project_id, provider_kind) DO UPDATE SET
         connection_id = EXCLUDED.connection_id, grant_id = EXCLUDED.grant_id,
         selected_by = EXCLUDED.selected_by, selected_at = now(), updated_at = now()
       RETURNING connection_id, grant_id`,
      [input.orgId, input.projectId, input.providerKind, input.connectionId, input.grantId, selectedBy],
    );
    if (result.rows[0] === undefined) return undefined;
    const resolved = await this.resolveControlGrant(client, input.orgId, input.projectId, input.providerKind, actor);
    return resolved.status === "selected" ? resolved.grant : undefined;
  },

  async revoke(
    client: IntegrationQueryClient,
    orgId: string,
    connectionId: string,
    _actor: ActorRef,
  ): Promise<boolean> {
    const result = await client.query(
      `WITH revoked_grants AS (
         UPDATE org_integration_grants SET status = 'revoked', revoked_at = now(), updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status <> 'revoked'
       )
       UPDATE org_integration_connections SET status = 'revoked', updated_at = now()
       WHERE org_id = $1 AND id = $2 AND status <> 'revoked' RETURNING id`,
      [orgId, connectionId],
    );
    return (result.rowCount ?? 0) > 0;
  },
} as const;
