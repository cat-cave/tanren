import type { EligibleOperationExpectation, EligibleOperationLease } from "../contracts/integrationAuthority.js";
import { assertEligibleOperationLease } from "../integrations/integrationAuthorityImpl.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { generationSecretRef, type IntegrationSecretStore } from "../contracts/integrationSecretStore.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export type IntegrationConnectionHealth = "unknown" | "healthy" | "degraded" | "invalid";

/**
 * Inventory listing only — never issues an EligibleOperationLease.
 * Provider I/O must go through IntegrationAuthority.authorizeOperation.
 */
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
  assertEligibleOperationLease(lease, {
    orgId: lease.orgId,
    projectId: lease.projectId,
    providerKind: lease.providerKind,
    capability: lease.capability,
    operation: lease.operation,
    target: lease.target,
  });
  return Object.freeze({
    orgId: lease.orgId,
    projectId: lease.projectId,
    connectionId: lease.connectionId,
    grantId: lease.grantId,
    providerKind: lease.providerKind,
    providerPrincipalId: lease.providerPrincipalId,
    authGeneration: lease.authGeneration,
    grantGeneration: lease.grantGeneration,
    metadata: lease.principalMetadata,
    eligibleOperation: lease,
  });
}

/** Reject consumer-constructed or mutated grant wrappers around an authentic lease. */
export function assertOrgGrantMatchesLease(grant: OrgGrant): void {
  const lease = grant.eligibleOperation;
  assertEligibleOperationLease(lease, {
    orgId: lease.orgId,
    projectId: lease.projectId,
    providerKind: lease.providerKind,
    capability: lease.capability,
    operation: lease.operation,
    target: lease.target,
  });
  if (
    grant.orgId !== lease.orgId ||
    grant.projectId !== lease.projectId ||
    grant.connectionId !== lease.connectionId ||
    grant.grantId !== lease.grantId ||
    grant.providerKind !== lease.providerKind ||
    grant.providerPrincipalId !== lease.providerPrincipalId ||
    grant.authGeneration !== lease.authGeneration ||
    grant.grantGeneration !== lease.grantGeneration ||
    grant.metadata !== lease.principalMetadata
  ) {
    throw new Error("org grant does not match eligible operation lease");
  }
}

export async function secretValueForLease(
  secrets: IntegrationSecretStore,
  lease: EligibleOperationLease,
  expected: EligibleOperationExpectation,
): Promise<string> {
  assertEligibleOperationLease(lease, expected);
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
