import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  defaultIntegrationResourceConstraints,
  type EligibleOperationExpectation,
  type EligibleOperationLease,
  type PrincipalVerificationPermit,
} from "../src/engine/contracts/integrationAuthority.js";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import type { IntegrationEligibilityRow } from "../src/engine/integrations/integrationAuthorityEligibility.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { secretValueForDeployOperation } from "../src/engine/provisioners/deployOperationAuthority.js";
import { loadDurableLinkStateSql } from "../src/engine/repositories/integrationConnectionFinalize.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import { secretValueForLease } from "../src/engine/repositories/integrationConnectionResolve.js";
import { testOrgGrant } from "./helpers/orgGrant.js";

const target = { resourceId: "app-1", sourceRepo: "owner/repo", sourceRef: "sha" } as const;
const expected: EligibleOperationExpectation = {
  orgId: "org-test",
  projectId: "proj-test",
  providerKind: "deploy.vercel",
  capability: "deploy",
  operation: "deploy",
  target,
};

function eligibilityRow(overrides: Partial<IntegrationEligibilityRow> = {}): IntegrationEligibilityRow {
  return {
    connection_id: "conn-1",
    provider_kind: "deploy.vercel",
    provider_principal_id: "team-1",
    display_name: "Team One",
    principal_metadata: { teamId: "team-1" },
    connection_health: "healthy",
    connection_status: "active",
    current_auth_generation: 1,
    grant_id: "grant-1",
    grant_current_generation: 1,
    grant_status: "active",
    plane: "control",
    environment: "control",
    credential_ref: "secret://org/test/integration/deploy.vercel/connection/c/token/g/1",
    auth_expires_at: null,
    auth_status: "active",
    capabilities: ["deploy"],
    operations: ["deploy", "attach_runtime_env"],
    provider_scopes: [],
    resource_constraints: defaultIntegrationResourceConstraints(),
    policy_revision: integrationCatalogRevision(),
    consent_revision: "consent.test",
    grant_expires_at: null,
    grant_generation_status: "active",
    selected_auth_generation: 1,
    selected_grant_generation: 1,
    selected_connection_id: "conn-1",
    selected_grant_id: "grant-1",
    ...overrides,
  };
}

function clientFor(row: IntegrationEligibilityRow): IntegrationQueryClient {
  return {
    async query() {
      return { rows: [row], rowCount: 1 };
    },
  };
}

describe("exact integration operation authority", () => {
  it("rejects every mismatched binding before any secret/provider coordinate is read", async () => {
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const grant = await testOrgGrant({
      providerKind: "deploy.vercel",
      capability: "deploy",
      operation: "deploy",
      target,
      credentialRef: "secret://org/test/integration/deploy.vercel/connection/c/token/g/1",
    });
    const mismatches: EligibleOperationExpectation[] = [
      { ...expected, orgId: "other-org" },
      { ...expected, projectId: "other-project" },
      { ...expected, providerKind: "deploy.flyio" },
      { ...expected, capability: "notify" },
      {
        ...expected,
        operation: "verify",
        target: { resourceId: "app-1", deploymentId: "deployment-1" },
      },
      { ...expected, target: { ...target, resourceId: "other-app" } },
      { ...expected, target: { ...target, sourceRef: "other-sha" } },
      {
        ...expected,
        target: { ...target, unclaimedCoordinate: "must-not-be-ignored" } as EligibleOperationExpectation["target"],
      },
    ];
    for (const mismatch of mismatches) {
      await expect(secretValueForLease(secrets, grant.eligibleOperation, mismatch)).rejects.toThrow(
        /binding mismatch/u,
      );
    }
    expect(secrets.getExactCallCount()).toBe(0);
  });

  it("rejects expired authority before secret/provider I/O", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const grant = await testOrgGrant({
        providerKind: "deploy.vercel",
        operation: "deploy",
        target,
        credentialRef: "secret://org/test/integration/deploy.vercel/connection/c/token/g/1",
      });
      const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
      vi.setSystemTime(new Date("2030-01-01T00:00:31.000Z"));
      await expect(secretValueForLease(secrets, grant.eligibleOperation, expected)).rejects.toThrow(/expired/u);
      expect(secrets.getExactCallCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows the exact operation and exact target only", async () => {
    const base = new InMemorySecretStore();
    const credentialRef = "secret://org/test/integration/deploy.vercel/connection/c/token/g/1";
    await base.put({ ref: credentialRef, value: "provider-token" });
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const grant = await testOrgGrant({
      providerKind: "deploy.vercel",
      operation: "deploy",
      target,
      credentialRef,
    });
    await expect(secretValueForLease(secrets, grant.eligibleOperation, expected)).resolves.toBe("provider-token");
    expect(secrets.getExactCallCount()).toBe(1);
  });

  it("rejects unsupported resource constraints before issuing a lease", async () => {
    const result = await new PgIntegrationAuthority().authorizeOperation(
      clientFor(eligibilityRow({ resource_constraints: {} })),
      { ...expected, actor: { kind: "operator", id: "test" } },
    );
    expect(result).toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
      candidates: [{ ineligibilityReasons: expect.arrayContaining(["unsupported_resource_constraints"]) }],
    });
    expect(result).not.toHaveProperty("lease");
  });

  it("enforces resource and environment allowlists before provider I/O", async () => {
    const result = await new PgIntegrationAuthority().authorizeOperation(
      clientFor(
        eligibilityRow({
          resource_constraints: {
            version: 1,
            projectBinding: "selected",
            resourceIds: ["allowed-app"],
            environments: [],
          },
        }),
      ),
      {
        orgId: "org-test",
        projectId: "proj-test",
        providerKind: "deploy.vercel",
        capability: "deploy",
        operation: "attach_runtime_env",
        target: { resourceId: "denied-app", environment: "production" },
        actor: { kind: "operator", id: "test" },
      },
    );
    expect(result).toMatchObject({
      status: "selection_required",
      candidates: [
        {
          ineligibilityReasons: expect.arrayContaining(["resource_not_allowed", "environment_not_allowed"]),
        },
      ],
    });
    expect(result).not.toHaveProperty("lease");
  });

  it("refuses revoked and stale selected generations without secret/provider I/O", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const providerIo = vi.fn<() => void>();
    const result = await new PgIntegrationAuthority().authorizeOperation(
      clientFor(
        eligibilityRow({
          auth_status: "revoked",
          grant_generation_status: "revoked",
          selected_auth_generation: 99,
        }),
      ),
      { ...expected, actor: { kind: "operator", id: "test" } },
    );
    expect(result).toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
      candidates: [
        {
          ineligibilityReasons: expect.arrayContaining([
            "auth_generation_not_active",
            "grant_generation_not_active",
            "selected_generation_stale",
          ]),
        },
      ],
    });
    expect(secrets.getExactCallCount()).toBe(0);
    expect(providerIo).not.toHaveBeenCalled();
  });

  it("rejects a consumer-tampered OrgGrant wrapper before reading its credential", async () => {
    const credentialRef = "secret://org/test/integration/deploy.vercel/connection/c/token/g/1";
    const base = new InMemorySecretStore();
    await base.put({ ref: credentialRef, value: "provider-token" });
    const getSpy = vi.spyOn(base, "get");
    const authentic = await testOrgGrant({
      providerKind: "deploy.vercel",
      operation: "deploy",
      target,
      credentialRef,
    });
    const tampered = { ...authentic, metadata: { ...authentic.metadata } } as OrgGrant;
    await expect(secretValueForDeployOperation(base, "deploy.vercel", tampered, "deploy", target)).rejects.toThrow(
      /org grant does not match/u,
    );
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("rejects cloned leases with altered grant or credential identity before secret I/O", async () => {
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    const grant = await testOrgGrant({
      providerKind: "deploy.vercel",
      operation: "deploy",
      target,
      credentialRef: "secret://org/test/integration/deploy.vercel/connection/c/token/g/1",
    });
    const altered: EligibleOperationLease[] = [
      { ...grant.eligibleOperation, connectionId: "other-connection" },
      { ...grant.eligibleOperation, grantId: "other-grant" },
      { ...grant.eligibleOperation, authGeneration: 2 },
      { ...grant.eligibleOperation, grantGeneration: 2 },
      { ...grant.eligibleOperation, credentialRef: "secret://org/test/integration/other/token/g/1" },
      { ...grant.eligibleOperation, providerPrincipalId: "other-principal" },
      { ...grant.eligibleOperation, policyRevision: "other-policy" },
      { ...grant.eligibleOperation, consentRevision: "other-consent" },
    ] as EligibleOperationLease[];
    for (const lease of altered) {
      await expect(secretValueForLease(secrets, lease, expected)).rejects.toThrow(/invalid eligible operation lease/u);
    }
    expect(secrets.getExactCallCount()).toBe(0);
  });

  it("rejects a structurally forged principal permit before finalization reads the database", async () => {
    const query = vi.fn<IntegrationQueryClient["query"]>();
    const forged = {
      orgId: "org-test",
      providerKind: "slack",
      operationId: "op-forged",
      actorId: "operator-test",
      stagedSecretHandle: "secret://integration/staged/op-forged",
    } as unknown as PrincipalVerificationPermit;
    await expect(loadDurableLinkStateSql({ query }, forged)).rejects.toThrow(/invalid principal verification permit/u);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps authority brands and issuers private to the sole implementation", () => {
    const root = resolve(import.meta.dirname, "../src/engine");
    const contract = readFileSync(resolve(root, "contracts/integrationAuthority.ts"), "utf8");
    const implementation = readFileSync(resolve(root, "integrations/integrationAuthorityImpl.ts"), "utf8");
    const consumer = readFileSync(resolve(root, "repositories/integrationConnectionResolve.ts"), "utf8");
    expect(contract).toContain("declare const eligibleOperationLeaseBrand");
    expect(contract).not.toMatch(/export\s+(?:declare\s+)?const\s+eligibleOperationLeaseBrand/u);
    expect(contract).not.toMatch(/export\s+(?:declare\s+)?const\s+principalVerificationPermitBrand/u);
    expect(implementation).toMatch(/function issueEligibleOperationLease/u);
    expect(implementation).not.toMatch(
      /export\s+function issue(?:EligibleOperationLease|PrincipalVerificationPermit)/u,
    );
    expect(consumer).not.toContain("issueEligibleOperationLease");
  });
});
