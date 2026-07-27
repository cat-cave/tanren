import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { integrationRequestFingerprint } from "../src/engine/integrations/integrationOperationFingerprint.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { SentryPrincipalVerifier, SlackPrincipalVerifier } from "../src/engine/integrations/principalVerifiers.js";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import { testOrgGrant, testPrincipalVerificationPermit } from "./helpers/orgGrant.js";
import { sentryOrganizationsResponse } from "./helpers/sentryIntakeAuthority.js";
import { requireSentryPrincipalIdentity } from "../src/engine/integrations/sentryPrincipalIdentity.js";
import { parseLinkHeader } from "../src/engine/integrations/linkHeader.js";

describe("IN-1 P1 authority former-bug proofs", () => {
  it("accepts legacy Sentry identity metadata and normalizes it to version 1", () => {
    expect(requireSentryPrincipalIdentity({ orgSlug: "o", baseUrl: "https://sentry.example" })).toEqual({
      sentryIdentityVersion: "1",
      orgSlug: "o",
      baseUrl: "https://sentry.example",
    });
    expect(() => requireSentryPrincipalIdentity({ orgSlug: "o", baseUrl: "http://sentry.example" })).toThrow();
  });
  it("parses commas and semicolons inside quoted Link parameters", () => {
    const [link, next] = parseLinkHeader(
      '<https://example.test/a>; title="a, b; c", <https://example.test/b>; rel="next"',
    );
    expect(link?.parameters.get("title")).toBe("a, b; c");
    expect(next?.parameters.get("rel")).toBe("next");
  });
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
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/organizations/") && !url.includes("?") && url.endsWith("/")) {
        return Response.json({ access: ["project:read", "project:write"] });
      }
      if (url.includes("/projects/")) return Response.json([]);
      return sentryOrganizationsResponse(
        [
          { id: "1", slug: "a", name: "A" },
          { id: "2", slug: "b", name: "B" },
        ],
        "https://sentry.example/root",
      );
    });
    const result = await new SentryPrincipalVerifier(
      fetchImpl as unknown as typeof fetch,
      "https://sentry.example/root",
    ).verify(permit, staged, secrets);
    expect(result.status).toBe("multi_principal");
    if (result.status !== "multi_principal") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.metadata).toEqual({
      sentryIdentityVersion: "1",
      orgSlug: "a",
      baseUrl: "https://sentry.example/root",
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/^https:\/\/sentry\.example\/root\/api\//u);
  });
  it.each([
    ["missing Link", undefined, false, "sentry_malformed_pagination"],
    ["blank Link", " ", false, "sentry_malformed_pagination"],
    ["ambiguous Link", "malformed", false, "sentry_malformed_pagination"],
    ["malformed row", undefined, true, "sentry_malformed_organizations"],
  ])("decodes every Sentry page before exposing identity: %s", async (_name, link, malformedRow, reason) => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-page", "token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "sentry", operationId: "op-page" });
    const later = malformedRow
      ? sentryOrganizationsResponse([{ id: "2" }], "https://sentry.example")
      : Response.json([{ id: "2", slug: "b" }], link === undefined ? {} : { headers: { link } });
    let page = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      page++ === 0
        ? sentryOrganizationsResponse([{ id: "1", slug: "a" }], "https://sentry.example", "0:100:0", true)
        : later,
    );
    const result = await new SentryPrincipalVerifier(
      fetchImpl as unknown as typeof fetch,
      "https://sentry.example",
    ).verify(permit, staged, secrets);
    expect(result).toEqual({ status: "unavailable", reason });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("preserves the legacy tuple without an endpoint and versions the bound tuple", () => {
    const request = {
      orgId: "o",
      providerKind: "sentry",
      operationKind: "link" as const,
      actorId: "u",
      credential: "token",
    };
    const digest = (parts: unknown[]) =>
      `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
    expect(integrationRequestFingerprint({ ...request, providerKind: "slack" })).toBe(
      digest(["tanren.integration-operation.v1", "o", "slack", "link", null, null, "u", "token"]),
    );
    expect(integrationRequestFingerprint({ ...request, providerEndpoint: "https://sentry.example/a" })).toBe(
      digest([
        "tanren.integration-operation.v2",
        "o",
        "sentry",
        "link",
        null,
        "https://sentry.example/a",
        "u",
        "token",
      ]),
    );
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
