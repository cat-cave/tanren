import {
  assertEligibleOperationLease,
  issueEligibleOperationLease,
  type EligibleOperationLease,
} from "../contracts/integrationAuthority.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { generationSecretRef, type IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export type IntegrationConnectionHealth = "unknown" | "healthy" | "degraded" | "invalid";

export async function resolveExactControlGrant(
  client: IntegrationQueryClient,
  input: {
    orgId: string;
    providerKind: string;
    connectionId: string;
    grantId: string;
    capability: string;
    operation: string;
    projectId?: string;
  },
): Promise<OrgGrant | undefined> {
  const result = await client.query(
    `SELECT c.id AS connection_id, c.provider_kind, c.provider_principal_id, c.principal_metadata,
            c.current_auth_generation, g.id AS grant_id, g.current_generation AS grant_generation,
            ag.credential_ref, gg.policy_revision, gg.consent_revision, gg.capabilities, gg.operations
     FROM org_integration_connections c
     JOIN org_integration_grants g
       ON g.org_id = c.org_id AND g.connection_id = c.id AND g.id = $4
      AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
     JOIN org_integration_connection_auth_generations ag
       ON ag.org_id = c.org_id AND ag.provider_kind = c.provider_kind
      AND ag.connection_id = c.id AND ag.generation = c.current_auth_generation AND ag.status = 'active'
     JOIN org_integration_grant_generations gg
       ON gg.org_id = g.org_id AND gg.provider_kind = g.provider_kind
      AND gg.connection_id = g.connection_id AND gg.grant_id = g.id
      AND gg.generation = g.current_generation AND gg.status = 'active'
     WHERE c.org_id = $1 AND c.provider_kind = $2 AND c.id = $3 AND c.status = 'active'
       AND c.health IN ('healthy','unknown')`,
    [input.orgId, input.providerKind, input.connectionId, input.grantId],
  );
  const row = result.rows[0] as
    | {
        connection_id: string;
        provider_kind: string;
        provider_principal_id: string;
        principal_metadata: Record<string, unknown>;
        current_auth_generation: number;
        grant_id: string;
        grant_generation: number;
        credential_ref: string;
        policy_revision: string;
        consent_revision: string;
        capabilities: string[] | null;
        operations: string[] | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  if (!(row.capabilities ?? []).includes(input.capability)) return undefined;
  if (!(row.operations ?? []).includes(input.operation)) return undefined;
  return orgGrantFromLease(
    issueEligibleOperationLease({
      orgId: input.orgId,
      projectId: input.projectId ?? "",
      providerKind: row.provider_kind,
      connectionId: row.connection_id,
      grantId: row.grant_id,
      authGeneration: row.current_auth_generation,
      grantGeneration: row.grant_generation,
      credentialRef: row.credential_ref,
      capability: input.capability,
      operation: input.operation,
      providerPrincipalId: row.provider_principal_id,
      principalMetadata: row.principal_metadata ?? {},
      policyRevision: row.policy_revision,
      consentRevision: row.consent_revision,
    }),
  );
}

export async function listExactControlGrants(
  client: IntegrationQueryClient,
  orgId: string,
  providerKind?: string,
): Promise<
  Array<{
    connectionId: string;
    grantId: string;
    providerKind: string;
    providerPrincipalId: string;
    displayName: string;
    health: IntegrationConnectionHealth;
    authGeneration: number;
    grantGeneration: number;
  }>
> {
  const result = await client.query(
    `SELECT c.id AS connection_id, g.id AS grant_id, c.provider_kind, c.provider_principal_id,
            c.display_name, c.health, c.current_auth_generation, g.current_generation AS grant_generation,
            g.status AS grant_status, c.status AS connection_status
     FROM org_integration_connections c
     LEFT JOIN org_integration_grants g
       ON g.org_id = c.org_id AND g.connection_id = c.id
      AND g.plane = 'control' AND g.environment = 'control' AND g.status = 'active'
     WHERE c.org_id = $1 AND c.status = 'active'
       AND ($2::text IS NULL OR c.provider_kind = $2)`,
    [orgId, providerKind ?? null],
  );
  return result.rows.flatMap((raw) => {
    const row = raw as {
      connection_id: string;
      grant_id: string | null;
      provider_kind: string;
      provider_principal_id: string;
      display_name: string;
      health: IntegrationConnectionHealth;
      current_auth_generation: number | null;
      grant_generation: number | null;
      grant_status: string | null;
      connection_status: string;
    };
    if (
      row.grant_id === null ||
      row.current_auth_generation === null ||
      row.grant_generation === null ||
      row.grant_status !== "active" ||
      row.connection_status !== "active"
    ) {
      return [];
    }
    return [
      {
        connectionId: row.connection_id,
        grantId: row.grant_id,
        providerKind: row.provider_kind,
        providerPrincipalId: row.provider_principal_id,
        displayName: row.display_name,
        health: row.health,
        authGeneration: row.current_auth_generation,
        grantGeneration: row.grant_generation,
      },
    ];
  });
}

export function orgGrantFromLease(lease: EligibleOperationLease): OrgGrant {
  assertEligibleOperationLease(lease);
  return {
    connectionId: lease.connectionId,
    grantId: lease.grantId,
    providerKind: lease.providerKind,
    providerPrincipalId: lease.providerPrincipalId,
    authGeneration: lease.authGeneration,
    grantGeneration: lease.grantGeneration,
    metadata: lease.principalMetadata,
    eligibleOperation: lease,
  };
}

export async function secretValueForLease(
  secrets: IntegrationSecretStore,
  lease: EligibleOperationLease,
): Promise<string> {
  assertEligibleOperationLease(lease);
  const value = await secrets.getExact({
    ref: lease.credentialRef.includes("/g/")
      ? lease.credentialRef
      : generationSecretRef(lease.credentialRef, lease.authGeneration),
    generation: lease.authGeneration,
  });
  if (value === undefined) {
    throw new Error(`missing integration secret for generation ${lease.authGeneration}`);
  }
  return value;
}
