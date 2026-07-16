import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { SlackPrincipalVerifier } from "../src/engine/integrations/principalVerifiers.js";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import { testOrgGrant, testPrincipalVerificationPermit } from "./helpers/orgGrant.js";

describe("IN-1 P1 authority former-bug proofs", () => {
  it("caller-labelled identity cannot be stored — provider response is authoritative", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-1", "xoxb-token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "slack", operationId: "op-1" });
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, team_id: "T_PROVIDER", team: "Provider Team", user_id: "U1" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "channels:read,channels:manage",
          },
        }),
    );
    const result = await new SlackPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.principal.providerPrincipalId).toBe("T_PROVIDER");
    expect(result.principal.providerPrincipalId).not.toBe("caller-labelled-workspace");
  });

  it("invalid credentials activate nothing", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-bad", "bad-token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "slack", operationId: "op-bad" });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: false, error: "invalid_auth" }));
    const result = await new SlackPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(result).toEqual({ status: "invalid", reason: "invalid_auth" });
    await secrets.compensate(staged);
  });

  it("multi-principal credentials are never guessed", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-multi", "token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "sentry", operationId: "op-multi" });
    const { SentryPrincipalVerifier } = await import("../src/engine/integrations/principalVerifiers.js");
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/organizations/") && !url.includes("?") && url.endsWith("/")) {
        return Response.json({ access: ["project:read", "project:write"] });
      }
      if (url.includes("/projects/")) return Response.json([]);
      return Response.json([
        { id: "1", slug: "a", name: "A" },
        { id: "2", slug: "b", name: "B" },
      ]);
    });
    const result = await new SentryPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(result.status).toBe("multi_principal");
    if (result.status !== "multi_principal") return;
    expect(result.candidates).toHaveLength(2);
  });

  it("failed finalization leaves prior generation readable and new generation absent", async () => {
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    await base.put({ ref: "secret://org/o/integration/slack/connection/c/token/g/1", value: "old" });
    const staged = await secrets.stage("op-rot", "new-token");
    // Simulate finalize conflict by pre-seeding a different generation-2 value.
    await base.put({ ref: "secret://org/o/integration/slack/connection/c/token/g/2", value: "other" });
    await expect(secrets.finalize(staged, "secret://org/o/integration/slack/connection/c/token", 2)).rejects.toThrow(
      /already exists/u,
    );
    expect(
      await secrets.getExact({ ref: "secret://org/o/integration/slack/connection/c/token/g/1", generation: 1 }),
    ).toBe("old");
  });

  it("getExact is generation-addressed and never implicit latest", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-g", "v1");
    const coord = await secrets.finalize(staged, "secret://org/o/integration/slack/connection/c/token", 1);
    expect(coord.generation).toBe(1);
    expect(await secrets.getExact(coord)).toBe("v1");
    expect(secrets.getExactCallCount()).toBe(1);
  });

  it("eligible operation lease is opaque and carries catalog policy revision", async () => {
    const grant = await testOrgGrant({
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
    const lease = grant.eligibleOperation;
    expect(lease.policyRevision).toBe(integrationCatalogRevision());
    expect(lease.policyRevision).not.toBe("manual-link.v1");
  });
});
