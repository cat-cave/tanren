import type { IntegrationOperationTarget, IntegrationPrivilegedOperation } from "../contracts/integrationAuthority.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { assertEligibleOperationLease } from "../integrations/integrationAuthorityImpl.js";
import { assertOrgGrantMatchesLease } from "../repositories/integrationConnectionResolve.js";

/** Validate a deploy grant even when the operation does not need a provider secret. */
export function assertDeployOperationAuthority(
  providerKind: string,
  grant: OrgGrant,
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
): void {
  assertOrgGrantMatchesLease(grant);
  assertEligibleOperationLease(grant.eligibleOperation, {
    orgId: grant.orgId,
    projectId: grant.projectId,
    providerKind,
    capability: "deploy",
    operation,
    target,
  });
}

/** Resolve a deploy token only after validating the exact provider operation. */
export async function secretValueForDeployOperation(
  secrets: SecretStore,
  providerKind: string,
  grant: OrgGrant,
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
): Promise<string> {
  const { GenerationAddressedIntegrationSecretStore } = await import("../integrations/integrationSecretStoreImpl.js");
  const { secretValueForLease } = await import("../repositories/integrationConnectionResolve.js");
  assertDeployOperationAuthority(providerKind, grant, operation, target);
  return secretValueForLease(new GenerationAddressedIntegrationSecretStore(secrets), grant.eligibleOperation, {
    orgId: grant.orgId,
    projectId: grant.projectId,
    providerKind,
    capability: "deploy",
    operation,
    target,
  });
}
