import { describe, expect, it } from "vitest";
import {
  IntegrationIdempotencyConflictError,
  IntegrationLegacyOperationNotFoundError,
  type AuthorizePrincipalVerificationInput,
} from "../src/engine/contracts/integrationAuthority.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import {
  integrationRequestFingerprint,
  legacyIntegrationRequestFingerprint,
  SENTRY_SAAS_ENDPOINT,
} from "../src/engine/integrations/integrationOperationFingerprint.js";
import type { MemoryOperation } from "./helpers/integrationMemoryTables.js";
import { IntegrationMemoryDb } from "./helpers/integrationMemoryDb.js";

const ORG_ID = "org_legacy_retry";
const ACTOR_ID = "admin_legacy_retry";
const ENDPOINT = "https://sentry.io";

function operation(overrides: Partial<MemoryOperation>): MemoryOperation {
  return {
    id: "op-legacy",
    org_id: ORG_ID,
    provider_kind: "sentry",
    connection_id: null,
    operation_kind: "link",
    stage: "awaiting_principal_selection",
    status: "awaiting_principal_selection",
    idempotency_key: "legacy-key",
    actor_id: ACTOR_ID,
    request_fingerprint: `sha256:${"0".repeat(64)}`,
    verification_fingerprint: null,
    verified_principal: null,
    verified_auth_kind: null,
    verified_scopes: null,
    verified_expires_at: null,
    reserved_connection_id: null,
    reserved_credential_ref: null,
    staged_secret_handle: null,
    candidate_principals: [],
    selected_principal_id: null,
    target_auth_generation: null,
    target_grant_id: null,
    target_grant_generation: null,
    reserved_capabilities: null,
    reserved_operations: null,
    reserved_policy_revision: null,
    reserved_consent_revision: null,
    reserved_consented_at: null,
    failure_classification: null,
    compensation_state: {},
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function fingerprints(input: {
  providerKind: string;
  operationKind: "link" | "rotate";
  connectionId?: string;
  credential: string;
}) {
  const base = { orgId: ORG_ID, actorId: ACTOR_ID, ...input };
  return {
    legacy: legacyIntegrationRequestFingerprint(base),
    current: integrationRequestFingerprint({ ...base, providerEndpoint: ENDPOINT }),
  };
}

function authorizationInput(
  input: Pick<AuthorizePrincipalVerificationInput, "providerKind" | "operationKind" | "connectionId">,
  hashes: ReturnType<typeof fingerprints>,
  options: Pick<AuthorizePrincipalVerificationInput, "legacyRetryOnly"> = {},
): AuthorizePrincipalVerificationInput {
  return {
    orgId: ORG_ID,
    ...input,
    idempotencyKey: input.operationKind === "rotate" ? "legacy-rotate" : "legacy-key",
    requestFingerprint: hashes.current,
    ...(input.providerKind === "sentry" ? { providerEndpoint: SENTRY_SAAS_ENDPOINT } : {}),
    legacyRequestFingerprint: hashes.legacy,
    ...options,
    actor: { kind: "operator", id: ACTOR_ID },
  };
}

describe("legacy integration operation authorization", () => {
  it.each([
    { operationKind: "link" as const, connectionId: undefined, key: "legacy-key" },
    { operationKind: "rotate" as const, connectionId: "connection-1", key: "legacy-rotate" },
  ])("migrates a historical Sentry $operationKind v1 row to v2", async ({ operationKind, connectionId, key }) => {
    const db = new IntegrationMemoryDb();
    const hashes = fingerprints({ providerKind: "sentry", operationKind, connectionId, credential: "token" });
    db.operations.push(
      operation({
        connection_id: connectionId ?? null,
        operation_kind: operationKind,
        idempotency_key: key,
        request_fingerprint: hashes.legacy,
      }),
    );
    const authority = new PgIntegrationAuthority();

    const permit = await authority.authorizePrincipalVerification(
      db.clientForOrg(ORG_ID),
      authorizationInput({ providerKind: "sentry", operationKind, connectionId }, hashes),
    );
    expect(permit).toMatchObject({ operationId: "op-legacy", providerKind: "sentry" });
    expect(db.operations[0]?.request_fingerprint).toBe(hashes.current);

    const replay = await authority.authorizePrincipalVerification(db.clientForOrg(ORG_ID), {
      ...authorizationInput({ providerKind: "sentry", operationKind, connectionId }, hashes),
      legacyRequestFingerprint: undefined,
    });
    expect(replay.operationId).toBe(permit.operationId);
    expect(db.operations).toHaveLength(1);
  });

  it("does not use the legacy escape hatch for a non-Sentry row", async () => {
    const db = new IntegrationMemoryDb();
    const hashes = fingerprints({ providerKind: "slack", operationKind: "link", credential: "token" });
    db.operations.push(operation({ provider_kind: "slack", request_fingerprint: hashes.legacy }));
    const authority = new PgIntegrationAuthority();

    await expect(
      authority.authorizePrincipalVerification(
        db.clientForOrg(ORG_ID),
        authorizationInput({ providerKind: "slack", operationKind: "link" }, hashes),
      ),
    ).rejects.toThrow(/restricted to Sentry/u);
    expect(db.operations[0]?.request_fingerprint).toBe(hashes.legacy);
  });

  it("keeps v2 endpoint changes conflicting even when a v1 digest is supplied", async () => {
    const db = new IntegrationMemoryDb();
    const first = fingerprints({ providerKind: "sentry", operationKind: "link", credential: "token" });
    const otherEndpoint = integrationRequestFingerprint({
      orgId: ORG_ID,
      providerKind: "sentry",
      operationKind: "link",
      actorId: ACTOR_ID,
      credential: "token",
      providerEndpoint: "https://sentry.example",
    });
    db.operations.push(operation({ request_fingerprint: first.current }));
    const authority = new PgIntegrationAuthority();

    await expect(
      authority.authorizePrincipalVerification(
        db.clientForOrg(ORG_ID),
        authorizationInput(
          { providerKind: "sentry", operationKind: "link" },
          { legacy: first.legacy, current: otherEndpoint },
        ),
      ),
    ).rejects.toBeInstanceOf(IntegrationIdempotencyConflictError);
    expect(db.operations[0]?.request_fingerprint).toBe(first.current);
  });

  it("does not migrate a historical v1 row for a non-SaaS Sentry endpoint", async () => {
    const db = new IntegrationMemoryDb();
    const hashes = fingerprints({ providerKind: "sentry", operationKind: "link", credential: "token" });
    const custom = integrationRequestFingerprint({
      orgId: ORG_ID,
      providerKind: "sentry",
      operationKind: "link",
      actorId: ACTOR_ID,
      credential: "token",
      providerEndpoint: "https://sentry.example",
    });
    db.operations.push(operation({ request_fingerprint: hashes.legacy }));

    await expect(
      new PgIntegrationAuthority().authorizePrincipalVerification(db.clientForOrg(ORG_ID), {
        ...authorizationInput({ providerKind: "sentry", operationKind: "link" }, { ...hashes, current: custom }),
        providerEndpoint: "https://sentry.example",
      }),
    ).rejects.toThrow(/restricted to Sentry SaaS/u);
    expect(db.operations[0]?.request_fingerprint).toBe(hashes.legacy);
  });

  it("does not create an operation for a missing endpoint legacy retry", async () => {
    const db = new IntegrationMemoryDb();
    const hashes = fingerprints({ providerKind: "sentry", operationKind: "link", credential: "token" });

    await expect(
      new PgIntegrationAuthority().authorizePrincipalVerification(db.clientForOrg(ORG_ID), {
        ...authorizationInput({ providerKind: "sentry", operationKind: "link" }, hashes),
        legacyRetryOnly: true,
      }),
    ).rejects.toBeInstanceOf(IntegrationLegacyOperationNotFoundError);
    expect(db.operations).toHaveLength(0);
  });

  it("authorizes an endpoint-less legacy retry and upgrades its v1 row", async () => {
    const db = new IntegrationMemoryDb();
    const hashes = fingerprints({ providerKind: "sentry", operationKind: "link", credential: "token" });
    db.operations.push(operation({ request_fingerprint: hashes.legacy }));
    const permit = await new PgIntegrationAuthority().authorizePrincipalVerification(db.clientForOrg(ORG_ID), {
      ...authorizationInput({ providerKind: "sentry", operationKind: "link" }, hashes),
      legacyRetryOnly: true,
    });
    expect(permit.operationId).toBe("op-legacy");
    expect(db.operations[0]?.request_fingerprint).toBe(hashes.current);
  });
});
