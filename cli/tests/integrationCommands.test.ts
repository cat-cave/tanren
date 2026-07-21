// in-21 — CLI integrations commands driven end-to-end against a real local
// stub orchestrator. Each test asserts the OBSERVABLE outcome (the JSON the
// command prints) AND pins the request contract by reading the request the
// server received (method/path/query/body) by value. Mirrors the
// productCommands.test.ts harness exactly.

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as IntegrationsNs from "../src/commands/integrations/index.js";
import { findProductHandler } from "../src/commands/dispatch.js";
import { captureStdout } from "./helpers/captureOutput.js";
import { startStubServer, type StubServer } from "./helpers/stubServer.js";

let server: StubServer;

async function loadCommands(): Promise<typeof IntegrationsNs> {
  // Re-import so the httpClient's module-level orchestratorUrl is recomputed
  // from the env pointed at this test's freshly-listening stub server.
  vi.resetModules();
  const integrations = await import("../src/commands/integrations/index.js");
  return integrations as typeof IntegrationsNs;
}

async function withStub(responseBody: unknown): Promise<typeof IntegrationsNs> {
  server = await startStubServer(responseBody);
  process.env.TANREN_PUBLIC_BASE_URL = server.url;
  // Isolate from any developer auth file so no bearer header leaks in.
  process.env.TANREN_AUTH_FILE = "/nonexistent/tanren-integrations-cli-auth.json";
  return loadCommands();
}

afterEach(async () => {
  await server?.close();
  delete process.env.TANREN_PUBLIC_BASE_URL;
  delete process.env.TANREN_AUTH_FILE;
});

describe("in-21 integrations CLI commands", () => {
  it("dispatches the five integration read subcommands by `<command> <subcommand>` pair", () => {
    expect(findProductHandler("integrations", "lifecycle")).toBeDefined();
    expect(findProductHandler("integrations", "requirements")).toBeDefined();
    expect(findProductHandler("integrations", "capability-nodes")).toBeDefined();
    expect(findProductHandler("integrations", "bindings")).toBeDefined();
    expect(findProductHandler("integrations", "delivery")).toBeDefined();
    expect(findProductHandler("integrations", "unknown")).toBeUndefined();
  });

  it("integrations lifecycle hits the in-20 lifecycle endpoint and prints the result", async () => {
    const body = {
      version: "v1",
      orgId: "org_acme",
      projectId: "project_1",
      requirements: { total: 1, needsAttention: 0 },
      capabilityNodes: { total: 1, awaitingGrant: 0, ready: 1, needsAttention: 0 },
      bindings: { total: 1, ready: 1, drifted: 0, needsAttention: 0 },
      deliveries: { total: 1, completed: 1, degraded: 0, needsAttention: 0 },
    };
    const integrations = await withStub(body);
    const out = await captureStdout(() =>
      integrations.integrationsLifecycle(["--org-id", "org_acme", "--project-id", "project_1"]),
    );
    expect(out.json()).toEqual(body);
    const sent = server.lastRequest();
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe("/v1/orgs/org_acme/projects/project_1/integrations/lifecycle");
  });

  it("integrations requirements hits the requirements endpoint and prints the result", async () => {
    const body = { version: "v1", orgId: "org_acme", projectId: "project_1", requirements: [] };
    const integrations = await withStub(body);
    const out = await captureStdout(() =>
      integrations.integrationsRequirements(["--org-id", "org_acme", "--project-id", "project_1"]),
    );
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/v1/orgs/org_acme/projects/project_1/integration-requirements");
  });

  it("integrations capability-nodes hits the capability-nodes endpoint and prints the result", async () => {
    const body = { version: "v1", orgId: "org_acme", projectId: "project_1", capabilityNodes: [] };
    const integrations = await withStub(body);
    const out = await captureStdout(() =>
      integrations.integrationsCapabilityNodes(["--org-id", "org_acme", "--project-id", "project_1"]),
    );
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/v1/orgs/org_acme/projects/project_1/capability-nodes");
  });

  it("integrations bindings hits the integration-bindings endpoint and prints the result", async () => {
    const body = { version: "v1", orgId: "org_acme", projectId: "project_1", bindings: [] };
    const integrations = await withStub(body);
    const out = await captureStdout(() =>
      integrations.integrationsBindings(["--org-id", "org_acme", "--project-id", "project_1"]),
    );
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/v1/orgs/org_acme/projects/project_1/integration-bindings");
  });

  it("integrations delivery hits the delivery endpoint and prints the result", async () => {
    const body = { version: "v1", orgId: "org_acme", projectId: "project_1", deliveryRuns: [] };
    const integrations = await withStub(body);
    const out = await captureStdout(() =>
      integrations.integrationsDelivery(["--org-id", "org_acme", "--project-id", "project_1"]),
    );
    expect(out.json()).toEqual(body);
    expect(server.lastRequest().path).toBe("/v1/orgs/org_acme/projects/project_1/delivery");
  });

  it("rejects a missing --org-id at the gate before any orchestrator call (CX-style fail-closed)", async () => {
    const integrations = await withStub({ version: "v1" });
    await expect(integrations.integrationsLifecycle(["--project-id", "project_1"])).rejects.toThrow(
      /missing --org-id/u,
    );
    // No request reached the stub.
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("rejects a missing --project-id at the gate before any orchestrator call", async () => {
    const integrations = await withStub({ version: "v1" });
    await expect(integrations.integrationsBindings(["--org-id", "org_acme"])).rejects.toThrow(/missing --project-id/u);
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });
});
