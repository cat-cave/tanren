import { describe, expect, it, vi } from "vitest";
import { sentryOrganizationsResponse } from "./helpers/sentryIntakeAuthority.js";
import { admin, harness } from "./integrationRoutes.contract.helpers.js";
import {
  integrationRequestFingerprint,
  legacyIntegrationRequestFingerprint,
} from "../src/engine/integrations/integrationOperationFingerprint.js";

describe("legacy Sentry route retries", () => {
  it("replays an endpoint-less link, then explicitly migrates it when bound", async () => {
    const token = "pre-endpoint-token";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sentryOrganizationsResponse([
        { id: "org-a", slug: "a", name: "A" },
        { id: "org-b", slug: "b", name: "B" },
      ]),
    ) as unknown as typeof fetch;
    const { app, database } = harness({ actor: admin, fetchImpl });
    const first = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, idempotencyKey: "legacy-route", baseUrl: "https://sentry.io" }),
    });
    expect(first.status).toBe(202);
    expect((await first.json()) as { status: string }).toMatchObject({ status: "awaiting_principal_selection" });

    const operation = database.memory.operations[0];
    operation.request_fingerprint = legacyIntegrationRequestFingerprint({
      orgId: "org_acme",
      providerKind: "sentry",
      operationKind: "link",
      actorId: admin.userId,
      credential: token,
    });
    fetchImpl.mockClear();

    const retry = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, idempotencyKey: "legacy-route" }),
    });
    expect(retry.status).toBe(202);
    expect((await retry.json()) as { status: string }).toMatchObject({ status: "awaiting_principal_selection" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(operation.request_fingerprint).toBe(
      legacyIntegrationRequestFingerprint({
        orgId: "org_acme",
        providerKind: "sentry",
        operationKind: "link",
        actorId: admin.userId,
        credential: token,
      }),
    );

    const migrate = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, idempotencyKey: "legacy-route", baseUrl: "https://sentry.io" }),
    });
    expect(migrate.status).toBe(202);
    expect(operation.request_fingerprint).toBe(
      integrationRequestFingerprint({
        orgId: "org_acme",
        providerKind: "sentry",
        operationKind: "link",
        actorId: admin.userId,
        credential: token,
        providerEndpoint: "https://sentry.io",
      }),
    );
  });

  it("replays a historical Sentry rotation through the endpoint-less path", async () => {
    const endpoint = "https://sentry.io";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sentryOrganizationsResponse([{ id: "org-a", slug: "a", name: "A" }], endpoint),
    ) as unknown as typeof fetch;
    const { app, database } = harness({ actor: admin, fetchImpl });
    const linked = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "link-token", idempotencyKey: "rotation-link", baseUrl: endpoint }),
    });
    expect(linked.status).toBe(202);
    const { connectionId } = (await linked.json()) as { connectionId: string };

    const rotated = await app.request(`/orgs/org_acme/integrations/sentry/connections/${connectionId}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "rotation-token", idempotencyKey: "legacy-rotation" }),
    });
    expect(rotated.status).toBe(202);
    const operation = database.memory.operations.find((row) => row.idempotency_key === "legacy-rotation");
    expect(operation).toBeDefined();
    operation!.request_fingerprint = legacyIntegrationRequestFingerprint({
      orgId: "org_acme",
      providerKind: "sentry",
      operationKind: "rotate",
      connectionId,
      actorId: admin.userId,
      credential: "rotation-token",
    });
    const connection = database.memory.connections.find((row) => row.id === connectionId);
    expect(connection).toBeDefined();
    connection!.principal_metadata = { slug: "a" };
    fetchImpl.mockClear();

    const retry = await app.request(`/orgs/org_acme/integrations/sentry/connections/${connectionId}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "rotation-token", idempotencyKey: "legacy-rotation" }),
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ status: "completed", idempotentReplay: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(operation!.request_fingerprint).toBe(
      legacyIntegrationRequestFingerprint({
        orgId: "org_acme",
        providerKind: "sentry",
        operationKind: "rotate",
        connectionId,
        actorId: admin.userId,
        credential: "rotation-token",
      }),
    );
  });
});
