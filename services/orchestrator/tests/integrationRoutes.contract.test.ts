import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { GcpSecretManagerStore } from "../src/engine/contracts/gcpSecretManager.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { SentryProvisioner } from "../src/engine/providers/sentryProvisioner.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { sentryOrganizationsResponse } from "./helpers/sentryIntakeAuthority.js";
import { createIntegrationRoutes } from "../src/routes/integrations/index.js";
import {
  admin,
  harness,
  member,
  provisionPath,
  RecordingProvisioner,
  RouteDatabase,
  vercelFetchFor,
} from "./integrationRoutes.contract.helpers.js";
describe("integration routes auth + sanitization", () => {
  it("rejects unauthenticated and non-admin link before staging secrets", async () => {
    const secrets = new InMemorySecretStore();
    const unauth = new Hono<ActorContextEnv>();
    unauth.route("/orgs", createIntegrationRoutes({ database: new RouteDatabase(), secrets }));
    expect((await unauth.request("/orgs/org_acme/integrations")).status).toBe(401);
    const memberApp = harness({ actor: member, secrets }).app;
    const link = await memberApp.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t", idempotencyKey: "k1" }),
    });
    expect(link.status).toBe(403);
    expect(await secrets.list("secret://")).toEqual([]);
  });
  it("rejects invalid link bodies without provider I/O", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { app, database, secrets } = harness({ actor: admin, fetchImpl });
    const response = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t", idempotencyKey: "missing-endpoint" }),
    });
    expect(response.status).toBe(400);
    expect([
      database.memory.operations.length,
      (await secrets.list("secret://")).length,
      fetchImpl.mock.calls.length,
    ]).toEqual([0, 0, 0]);
  });
  it("rejects catalog providers without a verifier before operation, staging, or provider I/O", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const fetchImpl = vi.fn<typeof fetch>();
    const { app } = harness({ actor: admin, database, secrets, fetchImpl });
    const response = await app.request("/orgs/org_acme/integrations/deploy.manual_external", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "must-not-stage", idempotencyKey: "unsupported" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "principal_verifier_unavailable" });
    expect(database.memory.operations).toHaveLength(0);
    expect(await secrets.list("secret://")).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("fails integration writes closed on a non-atomic secret backend before any I/O", async () => {
    const database = new RouteDatabase();
    const backendFetch = vi.fn<typeof fetch>();
    const providerFetch = vi.fn<typeof fetch>();
    const secrets = new GcpSecretManagerStore({ project: "p", accessToken: "t", fetchImpl: backendFetch });
    const { app } = harness({ actor: admin, database, secrets, fetchImpl: providerFetch });
    const response = await app.request("/orgs/org_acme/integrations/slack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "must-not-stage", idempotencyKey: "unsupported-backend" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "atomic_secret_finalization_unavailable" });
    expect(database.memory.operations).toHaveLength(0);
    expect(backendFetch).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("fails Slack enable closed before provisioner/provider I/O", async () => {
    const provisioner = new RecordingProvisioner();
    const { app } = harness({ actor: admin, provisioner });
    const response = await app.request(provisionPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "notify", mode: "greenfield" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "slack_bot_delivery_adapter_unavailable" });
    expect(provisioner.calls).toBe(0);
  });
});
describe("verified principal link + multi-principal selection", () => {
  it("replays a legacy-v1 Slack operation without staging or provider I/O", async () => {
    const secrets = new InMemorySecretStore();
    const integrationSecrets = new GenerationAddressedIntegrationSecretStore(secrets);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, team_id: "T1" }), {
          headers: { "x-oauth-scopes": "channels:read" },
        }),
    ) as unknown as typeof fetch;
    const { app } = harness({ actor: admin, secrets, integrationSecrets, fetchImpl });
    const body = JSON.stringify({ token: "slack-token", idempotencyKey: "legacy-slack" });
    expect((await app.request("/orgs/org_acme/integrations/slack", { method: "POST", body })).status).toBe(202);
    const staged = vi.spyOn(integrationSecrets, "stage");
    fetchImpl.mockClear();
    const replay = await app.request("/orgs/org_acme/integrations/slack", { method: "POST", body });
    expect([replay.status, await replay.json(), staged.mock.calls.length, fetchImpl.mock.calls.length]).toEqual([
      202,
      expect.objectContaining({ status: "completed" }),
      0,
      0,
    ]);
  });
  it("links via provider-verified principal and never echoes tokens", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const { app } = harness({
      actor: admin,
      database,
      secrets,
      fetchImpl: vercelFetchFor("team_a"),
    });
    const response = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "token_team_a", idempotencyKey: "link-a" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ status: "awaiting_principal_selection" });
    const selected = await app.request(`/orgs/org_acme/integrations/operations/${body.operationId}/principal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPrincipalId: "team_a" }),
    });
    expect(await selected.json()).toMatchObject({ status: "completed", providerPrincipalId: "team_a" });
    expect(JSON.stringify(body)).not.toContain("token_team_a");
    expect(database.memory.connections[0]?.provider_principal_id).toBe("team_a");
  });
  it("returns awaiting_principal_selection for multi-principal credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/v2/user")) return Response.json({ user: { id: "user_1", username: "u" } });
      if (href.includes("/v2/teams")) {
        return Response.json({
          teams: [
            { id: "team_a", name: "A", slug: "a" },
            { id: "team_b", name: "B", slug: "b" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { app, database } = harness({ actor: admin, fetchImpl });
    const response = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "multi", idempotencyKey: "multi-1" }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ status: "awaiting_principal_selection" });
    expect(body.candidates).toHaveLength(3);
    expect(body.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerPrincipalId: "user_1", principalKind: "user" })]),
    );
    expect(database.memory.connections).toHaveLength(0);
  });
  it("re-probes and persists scopes for the selected Sentry organization only", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/0/organizations/?per_page=100")) {
        return sentryOrganizationsResponse([
          { id: "org-a", slug: "a", name: "A" },
          { id: "org-b", slug: "b", name: "B" },
        ]);
      }
      if (href.endsWith("/organizations/b/")) {
        return Response.json({ access: ["project:read", "project:write"] });
      }
      if (href.includes("/organizations/b/projects/")) return Response.json([{ slug: "b-project" }]);
      if (href.endsWith("/organizations/a/")) return Response.json({ access: ["project:read"] });
      if (href.includes("/organizations/a/projects/")) return Response.json([{ slug: "a-project" }]);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { app, database } = harness({ actor: admin, fetchImpl });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "sentry-multi", idempotencyKey: "sentry-multi", baseUrl: "https://sentry.io" }),
    });
    const pending = (await link.json()) as { operationId: string; status: string };
    expect(pending.status).toBe("awaiting_principal_selection");
    const selected = await app.request(`/orgs/org_acme/integrations/operations/${pending.operationId}/principal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPrincipalId: "org-b" }),
    });
    expect(selected.status).toBe(202);
    expect(await selected.json()).toMatchObject({ status: "completed", providerPrincipalId: "org-b" });
    expect(database.memory.grantGenerations[0]?.provider_scopes).toEqual(["project:read", "project:write"]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/organizations/a/"))).toBe(false);
  });
  it("rejects a legacy selected Sentry candidate before secret or provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sentryOrganizationsResponse([
        { id: "org-a", slug: "a" },
        { id: "org-b", slug: "b" },
      ]),
    ) as unknown as typeof fetch;
    const secrets = new InMemorySecretStore();
    const { app, database } = harness({ actor: admin, secrets, fetchImpl });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "legacy-candidate",
        idempotencyKey: "legacy-candidate",
        baseUrl: "https://sentry.io",
      }),
    });
    const pending = (await link.json()) as { operationId: string };
    database.memory.operations[0]!.candidate_principals[0] = {
      ...database.memory.operations[0]!.candidate_principals[0],
      metadata: {},
    };
    const reads = vi.spyOn(secrets, "get");
    fetchImpl.mockClear();
    const selected = await app.request(`/orgs/org_acme/integrations/operations/${pending.operationId}/principal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPrincipalId: "org-a" }),
    });
    expect(await selected.json()).toEqual({ error: "verified_provider_identity_required" });
    expect(selected.status).toBe(409);
    expect([reads.mock.calls.length, fetchImpl.mock.calls.length]).toEqual([0, 0]);
  });
  it("retains the awaiting Sentry operation when the selected-org scope probe is unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/api/0/organizations/?per_page=100")) {
        return sentryOrganizationsResponse([
          { id: "org-a", slug: "a", name: "A" },
          { id: "org-b", slug: "b", name: "B" },
        ]);
      }
      if (href.endsWith("/organizations/b/")) {
        return new Response("maintenance", { status: 503, headers: { "retry-after": "29" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const { app, database, secrets } = harness({ actor: admin, fetchImpl });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "sentry-retry", idempotencyKey: "sentry-retry", baseUrl: "https://sentry.io" }),
    });
    const pending = (await link.json()) as { operationId: string };
    const selected = await app.request(`/orgs/org_acme/integrations/operations/${pending.operationId}/principal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPrincipalId: "org-b" }),
    });
    expect(selected.status).toBe(202);
    expect(await selected.json()).toMatchObject({
      status: "provider_unavailable",
      reason: "sentry_scope_http_503",
      retryAfter: "29",
    });
    const operation = database.memory.operations[0]!;
    expect(operation).toMatchObject({
      stage: "awaiting_principal_selection",
      status: "awaiting_principal_selection",
      failure_classification: "sentry_scope_http_503",
      compensation_state: { retryAfter: "29" },
    });
    expect(await secrets.get(operation.staged_secret_handle!)).toMatchObject({ value: "sentry-retry" });
  });
  it("requires project selection before provider I/O and never returns credential refs", async () => {
    const database = new RouteDatabase();
    const secrets = new InMemorySecretStore();
    const provisioner = new RecordingProvisioner();
    const { app } = harness({
      actor: admin,
      database,
      secrets,
      provisioner,
      fetchImpl: vercelFetchFor("team_only"),
    });
    const linked = await app.request("/orgs/org_acme/integrations/deploy.vercel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t", idempotencyKey: "one" }),
    });
    expect(linked.status).toBe(202);
    const pending = (await linked.json()) as { operationId: string };
    const completed = await app.request(`/orgs/org_acme/integrations/operations/${pending.operationId}/principal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerPrincipalId: "team_only" }),
    });
    const linkedBody = (await completed.json()) as {
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
    };
    const memberApp = harness({ actor: member, database, secrets, provisioner }).app;
    const ambiguous = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ status: "selection_required" });
    expect(provisioner.calls).toBe(0);
    const selected = await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/deploy.vercel/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: linkedBody.connectionId,
        grantId: linkedBody.grantId,
        authGeneration: linkedBody.authGeneration,
        grantGeneration: linkedBody.grantGeneration,
      }),
    });
    expect(selected.status).toBe(200);
    const discovered = await memberApp.request(
      "/orgs/org_acme/projects/proj_1/integrations/discover?capability=deploy&providerKind=deploy.vercel",
    );
    expect(discovered.status).toBe(200);
    expect(provisioner.grants.at(-1)).toMatchObject({
      connectionId: linkedBody.connectionId,
      providerPrincipalId: "team_only",
    });
    expect(JSON.stringify(await discovered.json())).not.toContain("credentialRef");
  });
  it("returns structured not-linked without constructing a provider", async () => {
    const provisioner = new RecordingProvisioner();
    const { app } = harness({ actor: member, provisioner });
    const response = await app.request(provisionPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "errors", mode: "greenfield" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_linked", providerKind: "sentry" });
    expect(provisioner.calls).toBe(0);
  });
  it("lists verified principals and lifecycle without secret material", async () => {
    const database = new RouteDatabase();
    const endpoint = "https://sentry.example/root";
    const provisionHttp = { request: vi.fn() };
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sentryOrganizationsResponse([{ id: "org_1", slug: "acme", name: "Acme" }], endpoint),
    ) as unknown as typeof fetch;
    const { app, secrets } = harness({
      actor: admin,
      database,
      fetchImpl,
      buildProvisioner: () => new SentryProvisioner(provisionHttp, secrets),
    });
    const link = await app.request("/orgs/org_acme/integrations/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret-value", idempotencyKey: "sentry-1", baseUrl: endpoint }),
    });
    const linked = (await link.json()) as {
      connectionId: string;
      grantId: string;
      authGeneration: number;
      grantGeneration: number;
    };
    const memberApp = harness({ actor: member, database }).app;
    await memberApp.request("/orgs/org_acme/projects/proj_1/integrations/sentry/selection", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: linked.connectionId,
        grantId: linked.grantId,
        authGeneration: linked.authGeneration,
        grantGeneration: linked.grantGeneration,
      }),
    });
    const response = await memberApp.request("/orgs/org_acme/integrations?projectId=proj_1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      integrations: [{ providerKind: "sentry", providerPrincipalId: "org_1", selectedForProject: true }],
      lifecycle: { projectId: "proj_1", requirements: { total: 2, needsAttention: 1 } },
    });
    expect(JSON.stringify(body)).not.toContain("secret-value");
    expect(JSON.stringify(body)).not.toContain("credentialRef");
    const rotated = await app.request(`/orgs/org_acme/integrations/sentry/connections/${linked.connectionId}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "rotated-value", idempotencyKey: "sentry-rotate" }),
    });
    const rotatedBody = (await rotated.json()) as { authGeneration: number; grantGeneration: number; status: string };
    expect({ status: rotated.status, body: rotatedBody }).toMatchObject({
      status: 202,
      body: { status: "completed" },
    });
    database.memory.selections[0]!.auth_generation = rotatedBody.authGeneration;
    database.memory.selections[0]!.grant_generation = rotatedBody.grantGeneration;
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith(`${endpoint}/api/`))).toBe(true);
    const calls = fetchImpl.mock.calls.length;
    const secretCount = (await secrets.list("secret://")).length;
    database.memory.connections[0]!.principal_metadata = {};
    const reads = vi.spyOn(secrets, "get");
    const discover = await app.request("/orgs/org_acme/projects/proj_1/integrations/discover?capability=errors");
    const provision = await app.request(provisionPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "errors", mode: "greenfield" }),
    });
    expect([discover.status, await discover.json(), provision.status, await provision.json()]).toEqual([
      409,
      { error: "verified_provider_identity_required" },
      409,
      { error: "verified_provider_identity_required" },
    ]);
    expect([reads.mock.calls.length, provisionHttp.request.mock.calls.length]).toEqual([0, 0]);
    const legacy = await app.request(`/orgs/org_acme/integrations/sentry/connections/${linked.connectionId}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "unstaged", idempotencyKey: "legacy-rotate" }),
    });
    expect([
      `${legacy.status}:${((await legacy.json()) as { error?: string }).error}`,
      fetchImpl.mock.calls.length,
      (await secrets.list("secret://")).length,
    ]).toEqual(["409:verified_provider_identity_required", calls, secretCount]);
  });
});
