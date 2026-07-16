import type { IntegrationResourceConstraints } from "../contracts/integrationAuthority.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function instantsEqual(left: Date | string | null, right: string | undefined): boolean {
  if (left === null || right === undefined) return left === null && right === undefined;
  return new Date(left).getTime() === new Date(right).getTime();
}

function constraintSetEqual(actual: unknown, expected: "*" | readonly string[]): boolean {
  return expected === "*"
    ? actual === "*"
    : Array.isArray(actual) &&
        actual.length === expected.length &&
        actual.every((item, index) => item === expected[index]);
}

function resourceConstraintsEqual(actual: unknown, expected: IntegrationResourceConstraints): boolean {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  const row = actual as Record<string, unknown>;
  return (
    Object.keys(row).length === 4 &&
    row["version"] === expected.version &&
    row["projectBinding"] === expected.projectBinding &&
    constraintSetEqual(row["resourceIds"], expected.resourceIds) &&
    constraintSetEqual(row["environments"], expected.environments)
  );
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
    expiresAt?: string;
  },
): Promise<void> {
  const result = await client.query(
    `SELECT credential_ref, auth_kind, expires_at, status
     FROM org_integration_connection_auth_generations
     WHERE org_id = $1 AND provider_kind = $2 AND connection_id = $3 AND generation = $4`,
    [expected.orgId, expected.providerKind, expected.connectionId, expected.generation],
  );
  const row = result.rows[0] as
    | { credential_ref: string; auth_kind: string; expires_at: Date | string | null; status: string }
    | undefined;
  if (row === undefined) {
    throw new Error("auth_generation_conflict_missing");
  }
  if (
    row.credential_ref !== expected.credentialRef ||
    row.auth_kind !== expected.authKind ||
    !instantsEqual(row.expires_at, expected.expiresAt) ||
    row.status !== "active"
  ) {
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
    resourceConstraints: IntegrationResourceConstraints;
    policyRevision: string;
    consentRevision: string;
    consentActorId: string;
    consentedAt: string;
    expiresAt?: string;
  },
): Promise<void> {
  const result = await client.query(
    `SELECT capabilities, operations, provider_scopes, resource_constraints,
            policy_revision, consent_revision, consent_actor_id, consented_at, expires_at, status
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
        resource_constraints: Record<string, unknown>;
        policy_revision: string;
        consent_revision: string;
        consent_actor_id: string;
        consented_at: Date | string;
        expires_at: Date | string | null;
        status: string;
      }
    | undefined;
  if (row === undefined) throw new Error("grant_generation_conflict_missing");
  if (
    row.status !== "active" ||
    row.policy_revision !== expected.policyRevision ||
    row.consent_revision !== expected.consentRevision ||
    row.consent_actor_id !== expected.consentActorId ||
    !resourceConstraintsEqual(row.resource_constraints, expected.resourceConstraints) ||
    !instantsEqual(row.consented_at, expected.consentedAt) ||
    !instantsEqual(row.expires_at, expected.expiresAt) ||
    !arraysEqual(row.capabilities, expected.capabilities) ||
    !arraysEqual(row.operations, expected.operations) ||
    !arraysEqual(row.provider_scopes, expected.scopes)
  ) {
    throw new Error("grant_generation_immutable_conflict");
  }
}
