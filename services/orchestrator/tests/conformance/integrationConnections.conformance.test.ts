import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { integrationCatalogRevision } from "../../src/engine/contracts/integrationCatalog.js";
import { GenerationAddressedIntegrationSecretStore } from "../../src/engine/integrations/integrationSecretStoreImpl.js";
import { IntegrationConnectionsStore } from "../../src/engine/repositories/integrationConnections.js";
import { testOrgGrant } from "../helpers/orgGrant.js";

describe("integration connections P1 authority surface", () => {
  it("orgGrantFromLease rejects naked objects without brand", async () => {
    const grant = await testOrgGrant({ providerKind: "sentry", capability: "errors" });
    expect(grant.providerPrincipalId).toBeTruthy();
    expect(grant.eligibleOperation.policyRevision).toBe(integrationCatalogRevision());
    expect("credentialRef" in grant).toBe(false);
    expect(() => IntegrationConnectionsStore.orgGrantFromLease({} as never)).toThrow(/invalid eligible/u);
  });

  it("generation secret store is create-only per generation", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op", "token");
    const coord = await secrets.finalize(staged, "secret://org/o/integration/sentry/connection/c/token", 1);
    expect(await secrets.getExact(coord)).toBe("token");
    const staged2 = await secrets.stage("op2", "other");
    await expect(secrets.finalize(staged2, "secret://org/o/integration/sentry/connection/c/token", 1)).rejects.toThrow(
      /already exists/u,
    );
  });

  it("authority issuance is required for provider construction coordinates", async () => {
    const issued = await testOrgGrant({
      orgId: "o",
      projectId: "p",
      providerKind: "slack",
      connectionId: "c",
      grantId: "g",
      authGeneration: 1,
      grantGeneration: 1,
      credentialRef: "secret://x/g/1",
      capability: "notify",
      operation: "discover",
      target: {},
      providerPrincipalId: "T1",
    });
    const grant = IntegrationConnectionsStore.orgGrantFromLease(issued.eligibleOperation);
    expect(grant.connectionId).toBe("c");
    expect(grant.providerPrincipalId).toBe("T1");
  });
});
