import type { IntegrationQueryClient } from "./integrationQuery.js";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export async function assertIdenticalAuthGeneration(
  client: IntegrationQueryClient,
  expected: {
    orgId: string;
    providerKind: string;
    connectionId: string;
    generation: number;
    credentialRef: string;
    authKind: string;
  },
): Promise<void> {
  const result = await client.query(
    `SELECT credential_ref, auth_kind, status
     FROM org_integration_connection_auth_generations
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3 AND generation = $4`,
    [expected.orgId, expected.providerKind, expected.connectionId, expected.generation],
  );
  const row = result.rows[0] as { credential_ref: string; auth_kind: string; status: string } | undefined;
  if (row === undefined) {
    throw new Error("auth_generation_conflict_missing");
  }
  if (row.credential_ref !== expected.credentialRef || row.auth_kind !== expected.authKind || row.status !== "active") {
    throw new Error("auth_generation_immutable_conflict");
  }
}

export async function assertIdenticalGrantGeneration(
  client: IntegrationQueryClient,
  expected: {
    orgId: string;
    providerKind: string;
    connectionId: string;
    grantId: string;
    generation: number;
    capabilities: string[];
    operations: string[];
    scopes: string[];
    policyRevision: string;
    consentRevision: string;
  },
): Promise<void> {
  const result = await client.query(
    `SELECT capabilities, operations, provider_scopes, policy_revision, consent_revision, status
     FROM org_integration_grant_generations
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3
       AND grant_id = $4 AND generation = $5`,
    [expected.orgId, expected.providerKind, expected.connectionId, expected.grantId, expected.generation],
  );
  const row = result.rows[0] as
    | {
        capabilities: string[];
        operations: string[];
        provider_scopes: string[];
        policy_revision: string;
        consent_revision: string;
        status: string;
      }
    | undefined;
  if (row === undefined) throw new Error("grant_generation_conflict_missing");
  if (
    row.status !== "active" ||
    row.policy_revision !== expected.policyRevision ||
    row.consent_revision !== expected.consentRevision ||
    !arraysEqual(row.capabilities, expected.capabilities) ||
    !arraysEqual(row.operations, expected.operations) ||
    !arraysEqual(row.provider_scopes, expected.scopes)
  ) {
    throw new Error("grant_generation_immutable_conflict");
  }
}
