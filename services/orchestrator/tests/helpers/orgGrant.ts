import { issueEligibleOperationLease } from "../../src/engine/contracts/integrationAuthority.js";
import { integrationCatalogRevision } from "../../src/engine/contracts/integrationCatalog.js";
import type { OrgGrant } from "../../src/engine/contracts/integrationProvisioner.js";

/** Test helper: build a fully-shaped OrgGrant with an opaque eligible operation lease. */
export function testOrgGrant(
  input: {
    providerKind?: string;
    connectionId?: string;
    grantId?: string;
    providerPrincipalId?: string;
    authGeneration?: number;
    grantGeneration?: number;
    credentialRef?: string;
    metadata?: Record<string, unknown>;
    capability?: string;
    operation?: string;
    projectId?: string;
    orgId?: string;
  } = {},
): OrgGrant {
  const providerKind = input.providerKind ?? "slack";
  const authGeneration = input.authGeneration ?? 1;
  const baseRef =
    input.credentialRef?.replace(/\/g\/\d+$/u, "") ??
    `secret://org/test/integration/${providerKind}/connection/c/token`;
  const credentialRef = input.credentialRef?.includes("/g/") ? input.credentialRef : `${baseRef}/g/${authGeneration}`;
  const lease = issueEligibleOperationLease({
    orgId: input.orgId ?? "org-test",
    projectId: input.projectId ?? "proj-test",
    providerKind,
    connectionId: input.connectionId ?? "conn-1",
    grantId: input.grantId ?? "grant-1",
    authGeneration,
    grantGeneration: input.grantGeneration ?? 1,
    credentialRef,
    capability: input.capability ?? "notify",
    operation: input.operation ?? "provision",
    providerPrincipalId: input.providerPrincipalId ?? "principal-1",
    principalMetadata: input.metadata ?? {},
    policyRevision: integrationCatalogRevision(),
    consentRevision: "consent.test",
  });
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
