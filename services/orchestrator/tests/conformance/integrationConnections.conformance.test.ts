import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { integrationCatalogRevision } from "../../src/engine/contracts/integrationCatalog.js";
import { GenerationAddressedIntegrationSecretStore } from "../../src/engine/integrations/integrationSecretStoreImpl.js";
import { IntegrationConnectionsStore } from "../../src/engine/repositories/integrationConnections.js";
import { testOrgGrant } from "../helpers/orgGrant.js";
import type { IntegrationQueryClient } from "../../src/engine/repositories/integrationQuery.js";

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

  it("org-level inventory decodes an absent project selection as false", async () => {
    const client: IntegrationQueryClient = {
      async query(sql) {
        const selectedForProject = /COALESCE\(s\.connection_id/u.test(sql) ? false : null;
        return {
          rows: [
            {
              connection_id: "c",
              grant_id: "g",
              org_id: "o",
              provider_kind: "sentry",
              provider_principal_id: "principal",
              principal_kind: "organization",
              display_name: "Sentry",
              health: "healthy",
              connection_status: "active",
              current_auth_generation: 1,
              grant_generation: 1,
              grant_status: "active",
              auth_expires_at: null,
              provider_scopes: ["project:read"],
              operation_id: null,
              operation_stage: null,
              operation_status: null,
              selected_for_project: selectedForProject,
            },
          ],
          rowCount: 1,
        };
      },
    };
    const inventory = await IntegrationConnectionsStore.listInventory(client, "o");
    expect(inventory[0]?.selectedForProject).toBe(false);
  });
});
