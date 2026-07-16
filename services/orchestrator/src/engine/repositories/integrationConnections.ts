import { z } from "zod";
import type { EligibleOperationLease, PrincipalCandidate } from "../contracts/integrationAuthority.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import type { IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { FinalizeVerifiedLinkInput, FinalizeVerifiedLinkResult } from "./integrationConnectionFinalize.js";
export type { FinalizeVerifiedLinkInput, FinalizeVerifiedLinkResult };
import type { ActorRef } from "../state/actor.js";
import { listExactControlGrants, orgGrantFromLease, secretValueForLease } from "./integrationConnectionResolve.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export { listExactControlGrants, orgGrantFromLease, secretValueForLease };

export const INTEGRATION_CONNECTION_HEALTH = ["unknown", "healthy", "degraded", "invalid"] as const;
export type IntegrationConnectionHealth = (typeof INTEGRATION_CONNECTION_HEALTH)[number];
export const INTEGRATION_CONNECTION_STATUSES = ["active", "revoked"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];
export const INTEGRATION_GRANT_STATUSES = ["pending", "active", "expired", "revoked"] as const;
export type IntegrationGrantStatus = (typeof INTEGRATION_GRANT_STATUSES)[number];

const InventoryRow = z.object({
  connection_id: z.string(),
  grant_id: z.string().nullable(),
  org_id: z.string(),
  provider_kind: z.string(),
  provider_principal_id: z.string(),
  principal_kind: z.string(),
  display_name: z.string(),
  health: z.enum(INTEGRATION_CONNECTION_HEALTH),
  connection_status: z.enum(INTEGRATION_CONNECTION_STATUSES),
  current_auth_generation: z.coerce.number().int().positive().nullable(),
  grant_generation: z.coerce.number().int().positive().nullable(),
  grant_status: z.enum(INTEGRATION_GRANT_STATUSES).nullable(),
  auth_expires_at: z.union([z.string(), z.date()]).nullable().optional(),
  provider_scopes: z.array(z.string()).nullable().optional(),
  operation_id: z.string().nullable().optional(),
  operation_stage: z.string().nullable().optional(),
  operation_status: z.string().nullable().optional(),
  selected_for_project: z.boolean().optional().default(false),
});

export interface IntegrationConnectionInventoryRow {
  connectionId: string;
  grantId: string | undefined;
  orgId: string;
  providerKind: string;
  providerPrincipalId: string;
  principalKind: string;
  displayName: string;
  health: IntegrationConnectionHealth;
  connectionStatus: IntegrationConnectionStatus;
  currentAuthGeneration: number | undefined;
  grantGeneration: number | undefined;
  grantStatus: IntegrationGrantStatus | undefined;
  authExpiresAt: string | undefined;
  providerScopes: string[];
  pendingOperation: { operationId: string; stage: string; status: string } | undefined;
  selectedForProject: boolean;
}

function mapInventory(value: unknown): IntegrationConnectionInventoryRow {
  const row = InventoryRow.parse(value);
  return {
    connectionId: row.connection_id,
    grantId: row.grant_id ?? undefined,
    orgId: row.org_id,
    providerKind: row.provider_kind,
    providerPrincipalId: row.provider_principal_id,
    principalKind: row.principal_kind,
    displayName: row.display_name,
    health: row.health,
    connectionStatus: row.connection_status,
    currentAuthGeneration: row.current_auth_generation ?? undefined,
    grantGeneration: row.grant_generation ?? undefined,
    grantStatus: row.grant_status ?? undefined,
    authExpiresAt:
      row.auth_expires_at === null || row.auth_expires_at === undefined
        ? undefined
        : row.auth_expires_at instanceof Date
          ? row.auth_expires_at.toISOString()
          : row.auth_expires_at,
    providerScopes: row.provider_scopes ?? [],
    pendingOperation:
      row.operation_id === null || row.operation_id === undefined
        ? undefined
        : {
            operationId: row.operation_id,
            stage: row.operation_stage ?? "unknown",
            status: row.operation_status ?? "unknown",
          },
    selectedForProject: row.selected_for_project,
  };
}

export const IntegrationConnectionsStore = {
  async markOperationStaged(
    client: IntegrationQueryClient,
    orgId: string,
    operationId: string,
    stagedHandle: string,
  ): Promise<void> {
    await client.query(
      `UPDATE org_integration_connection_operations
       SET stage = 'credential_staged', status = 'in_progress',
           staged_secret_handle = $3, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [orgId, operationId, stagedHandle],
    );
  },

  async markAwaitingPrincipalSelection(
    client: IntegrationQueryClient,
    orgId: string,
    operationId: string,
    candidates: PrincipalCandidate[],
    verified?: { authKind: string; scopes: string[] },
  ): Promise<void> {
    await client.query(
      `UPDATE org_integration_connection_operations
       SET stage = 'awaiting_principal_selection', status = 'awaiting_principal_selection',
           candidate_principals = $3::jsonb,
           compensation_state = COALESCE(compensation_state, '{}'::jsonb) || $4::jsonb,
           updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [
        orgId,
        operationId,
        JSON.stringify(candidates),
        JSON.stringify({
          verifiedAuthKind: verified?.authKind ?? "api_key",
          verifiedScopes: verified?.scopes ?? [],
        }),
      ],
    );
  },

  async markOperationFailed(
    client: IntegrationQueryClient,
    orgId: string,
    operationId: string,
    classification: string,
  ): Promise<void> {
    await client.query(
      `UPDATE org_integration_connection_operations
       SET stage = 'failed', status = 'failed', failure_classification = $3, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [orgId, operationId, classification],
    );
  },

  async getOperation(
    client: IntegrationQueryClient,
    orgId: string,
    operationId: string,
  ): Promise<
    | {
        id: string;
        providerKind: string;
        connectionId: string | undefined;
        operationKind: string;
        stage: string;
        status: string;
        stagedSecretHandle: string | undefined;
        candidatePrincipals: PrincipalCandidate[];
        actorId: string;
        verifiedAuthKind: string | undefined;
        verifiedScopes: string[];
      }
    | undefined
  > {
    const result = await client.query(
      `SELECT id, provider_kind, connection_id, operation_kind, stage, status,
              staged_secret_handle, candidate_principals, actor_id, compensation_state
       FROM org_integration_connection_operations
       WHERE org_id = $1 AND id = $2`,
      [orgId, operationId],
    );
    const row = result.rows[0] as
      | {
          id: string;
          provider_kind: string;
          connection_id: string | null;
          operation_kind: string;
          stage: string;
          status: string;
          staged_secret_handle: string | null;
          candidate_principals: PrincipalCandidate[];
          actor_id: string;
          compensation_state: Record<string, unknown> | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const compensation = row.compensation_state ?? {};
    const scopes = compensation["verifiedScopes"];
    return {
      id: row.id,
      providerKind: row.provider_kind,
      connectionId: row.connection_id ?? undefined,
      operationKind: row.operation_kind,
      stage: row.stage,
      status: row.status,
      stagedSecretHandle: row.staged_secret_handle ?? undefined,
      candidatePrincipals: Array.isArray(row.candidate_principals) ? row.candidate_principals : [],
      actorId: row.actor_id,
      verifiedAuthKind:
        typeof compensation["verifiedAuthKind"] === "string" ? compensation["verifiedAuthKind"] : undefined,
      verifiedScopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
    };
  },

  async finalizeVerifiedLink(
    client: IntegrationQueryClient,
    input: FinalizeVerifiedLinkInput,
    secrets: IntegrationSecretStore,
  ): Promise<FinalizeVerifiedLinkResult> {
    const { finalizeVerifiedLinkSql } = await import("./integrationConnectionFinalize.js");
    return finalizeVerifiedLinkSql(client, input, secrets);
  },

  async listInventory(
    client: IntegrationQueryClient,
    orgId: string,
    projectId?: string,
  ): Promise<IntegrationConnectionInventoryRow[]> {
    const result = await client.query(
      `SELECT c.id AS connection_id, g.id AS grant_id, c.org_id, c.provider_kind,
              c.provider_principal_id, c.principal_kind, c.display_name, c.health,
              c.status AS connection_status, c.current_auth_generation,
              g.current_generation AS grant_generation, g.status AS grant_status,
              ag.expires_at AS auth_expires_at, gg.provider_scopes,
              op.id AS operation_id, op.stage AS operation_stage, op.status AS operation_status,
              (s.connection_id = c.id AND s.grant_id = g.id) AS selected_for_project
       FROM org_integration_connections c
       LEFT JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id
        AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
       LEFT JOIN org_integration_connection_auth_generations ag
         ON ag.org_id = c.org_id AND ag.provider_kind = c.provider_kind
        AND ag.connection_id = c.id AND ag.generation = c.current_auth_generation
       LEFT JOIN org_integration_grant_generations gg
         ON gg.org_id = g.org_id AND gg.provider_kind = g.provider_kind
        AND gg.connection_id = g.connection_id AND gg.grant_id = g.id
        AND gg.generation = g.current_generation
       LEFT JOIN LATERAL (
         SELECT o.id, o.stage, o.status
         FROM org_integration_connection_operations o
         WHERE o.org_id = c.org_id AND o.provider_kind = c.provider_kind
           AND (o.connection_id = c.id OR o.connection_id IS NULL)
           AND o.status IN ('pending','in_progress','awaiting_principal_selection')
         ORDER BY o.created_at DESC
         LIMIT 1
       ) op ON true
       LEFT JOIN project_integration_grant_selections s
         ON s.org_id = c.org_id AND s.project_id = $2 AND s.provider_kind = c.provider_kind
       WHERE c.org_id = $1 AND c.status = 'active'
       ORDER BY c.provider_kind, c.provider_principal_id`,
      [orgId, projectId ?? null],
    );
    return result.rows.map(mapInventory);
  },

  async selectControlGrant(
    client: IntegrationQueryClient,
    input: {
      orgId: string;
      projectId: string;
      providerKind: string;
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
    },
    actor: ActorRef,
  ): Promise<
    | {
        connectionId: string;
        grantId: string;
        providerPrincipalId: string;
        authGeneration: number;
        grantGeneration: number;
      }
    | undefined
  > {
    const selectedBy = actor.id ?? actor.label ?? actor.kind;
    const result = await client.query(
      `INSERT INTO project_integration_grant_selections
         (org_id, project_id, provider_kind, connection_id, auth_generation,
          grant_id, grant_generation, selected_by, selected_at, updated_at)
       SELECT p.org_id, p.project_id, c.provider_kind, c.id, $6, g.id, $7, $8, now(), now()
       FROM projects p
       JOIN org_integration_connections c
         ON c.org_id = p.org_id AND c.provider_kind = $3 AND c.id = $4 AND c.status = 'active'
        AND c.current_auth_generation = $6
       JOIN org_integration_grants g
         ON g.org_id = c.org_id AND g.connection_id = c.id AND g.id = $5
        AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
        AND g.current_generation = $7
       JOIN org_integration_connection_auth_generations ag
         ON ag.org_id = c.org_id AND ag.provider_kind = c.provider_kind
        AND ag.connection_id = c.id AND ag.generation = $6 AND ag.status = 'active'
       JOIN org_integration_grant_generations gg
         ON gg.org_id = g.org_id AND gg.provider_kind = g.provider_kind
        AND gg.connection_id = g.connection_id AND gg.grant_id = g.id
        AND gg.generation = $7 AND gg.status = 'active'
       WHERE p.org_id = $1 AND p.project_id = $2
       ON CONFLICT (org_id, project_id, provider_kind) DO UPDATE SET
         connection_id = EXCLUDED.connection_id,
         auth_generation = EXCLUDED.auth_generation,
         grant_id = EXCLUDED.grant_id,
         grant_generation = EXCLUDED.grant_generation,
         selected_by = EXCLUDED.selected_by,
         selected_at = now(),
         updated_at = now()
       RETURNING connection_id, grant_id, auth_generation, grant_generation`,
      [
        input.orgId,
        input.projectId,
        input.providerKind,
        input.connectionId,
        input.grantId,
        input.authGeneration,
        input.grantGeneration,
        selectedBy,
      ],
    );
    const row = result.rows[0] as
      | {
          connection_id: string;
          grant_id: string;
          auth_generation: number;
          grant_generation: number;
        }
      | undefined;
    if (row === undefined) return undefined;
    const principal = await client.query(
      `SELECT provider_principal_id FROM org_integration_connections
       WHERE org_id = $1 AND id = $2`,
      [input.orgId, row.connection_id],
    );
    const principalId = (principal.rows[0] as { provider_principal_id: string } | undefined)?.provider_principal_id;
    if (principalId === undefined) return undefined;
    return {
      connectionId: row.connection_id,
      grantId: row.grant_id,
      providerPrincipalId: principalId,
      authGeneration: row.auth_generation,
      grantGeneration: row.grant_generation,
    };
  },

  orgGrantFromLease(lease: EligibleOperationLease): OrgGrant {
    return orgGrantFromLease(lease);
  },

  /** Inventory only — never a lease authority. */
  listExactControlGrants,

  async revoke(
    client: IntegrationQueryClient,
    orgId: string,
    connectionId: string,
    _actor: ActorRef,
  ): Promise<boolean> {
    const result = await client.query(
      `WITH revoked_grants AS (
         UPDATE org_integration_grants SET status = 'revoked', updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status <> 'revoked'
       ), revoked_gens AS (
         UPDATE org_integration_grant_generations SET status = 'revoked'
         WHERE org_id = $1 AND connection_id = $2 AND status = 'active'
       )
       UPDATE org_integration_connections SET status = 'revoked', updated_at = now()
       WHERE org_id = $1 AND id = $2 AND status <> 'revoked' RETURNING id`,
      [orgId, connectionId],
    );
    return (result.rowCount ?? 0) > 0;
  },
} as const;
