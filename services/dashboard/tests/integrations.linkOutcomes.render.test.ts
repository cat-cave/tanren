import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECT = {
  projectId: "project_easy",
  name: "fixture",
  repoUrl: "https://github.com/cat-cave/fixture",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

let linkBody: unknown;
let operationBody: Record<string, unknown>;
let selectionBody: unknown;
let selectionStatus: number;
let selectionTransportFailure: boolean;

function stubPool(): Pool {
  const pool = new Pool();
  vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] });
  return pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (path.endsWith("/auth/me")) {
      return Response.json({ userId: "user_admin", csrfToken: "csrf", expiresAt: "2030-01-01" });
    }
    if (path.endsWith("/orgs")) return Response.json({ orgs: [ORG] });
    if (path.endsWith("/integrations/operations/op_public") && method === "GET") {
      return Response.json(operationBody);
    }
    if (path.endsWith("/integrations/operations/op_public/principal") && method === "POST") {
      if (selectionTransportFailure) throw new Error("selection transport unavailable");
      return Response.json(selectionBody, { status: selectionStatus });
    }
    if (path.endsWith("/orgs/org_acme/integrations/sentry") && method === "POST") {
      return Response.json(linkBody, { status: 202 });
    }
    if (path.endsWith("/orgs/org_acme/integrations") && method === "GET") {
      return Response.json({ integrations: [] });
    }
    if (path.endsWith("/orgs/org_acme/projects") && method === "GET") {
      return Response.json({ projects: [PROJECT] });
    }
    return new Response("not found", { status: 404 });
  });
}

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

function durableOperation(publicStatus: string): Record<string, unknown> {
  return {
    operationId: "op_public",
    providerKind: "sentry",
    operationKind: "link",
    stage: "credential_staged",
    status: "in_progress",
    publicStatus,
    candidates: [],
    ...(publicStatus === "provider_unavailable"
      ? { failureClassification: "sentry_scope_http_503", retryAfter: "2030-01-02T03:04:05.000Z" }
      : {}),
  };
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  linkBody = { status: "completed", operationId: "op_public" };
  operationBody = durableOperation("completed");
  selectionBody = { status: "completed", operationId: "op_public" };
  selectionStatus = 202;
  selectionTransportFailure = false;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

const outcomes = [
  { wire: "awaiting_principal_selection", expected: "awaiting_principal_selection" },
  { wire: "provider_unavailable", expected: "provider_unavailable" },
  { wire: "verification_in_progress", expected: "verification_in_progress" },
  { wire: "finalize_pending", expected: "finalize_pending" },
  { wire: "activate_pending", expected: "activate_pending" },
  { wire: "failed", expected: "failed" },
  { wire: undefined, expected: "malformed" },
  { wire: "future_unrecognized_state", expected: "unknown" },
] as const;

const selectionOutcomes = [
  { wire: "completed", expected: "completed", success: true },
  { wire: "awaiting_principal_selection", expected: "awaiting_principal_selection", success: false },
  { wire: "provider_unavailable", expected: "provider_unavailable", success: false },
  { wire: "verification_in_progress", expected: "verification_in_progress", success: false },
  { wire: "finalize_pending", expected: "finalize_pending", success: false },
  { wire: "activate_pending", expected: "activate_pending", success: false },
  { wire: "failed", expected: "failed", success: false },
  { wire: "compensated", expected: "failed", success: false },
  { wire: undefined, expected: "malformed", success: false },
  { wire: "future_unrecognized_state", expected: "unknown", success: false },
] as const;

async function selectPrincipal() {
  return (await build()).request("/integrations/select-principal", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "operationId=op_public&providerPrincipalId=principal_exact",
  });
}

describe("integration link outcome route and render contract", () => {
  it("uses completed as the sole linked success branch", async () => {
    const app = await build();
    const response = await app.request("/integrations/link", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "providerKind=sentry&token=form-secret&idempotencyKey=link-complete",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("linked%20sentry");
    expect(location).not.toContain("principalOp");
  });

  it.each(outcomes)("renders $expected without false success for wire status $wire", async ({ wire, expected }) => {
    linkBody = {
      ...(wire === undefined ? {} : { status: wire }),
      operationId: "op_public",
      operationUrl: "javascript:alert(1)",
      reason: "<script>provider body</script>",
      token: "response-secret",
    };
    operationBody = durableOperation(["malformed", "unknown"].includes(expected) ? "completed" : expected);
    const app = await build();
    const response = await app.request("/integrations/link", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "providerKind=sentry&token=form-secret&idempotencyKey=link-pending",
    });
    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(303);
    expect(location).toContain("principalOp=op_public");
    expect(location).not.toContain("linked%20sentry");
    expect(location).not.toContain("secret");
    expect(location).not.toContain("javascript");
    expect(location).not.toContain("script");

    const html = await (await app.request(location)).text();
    expect(html).toContain(`data-principal-status="${expected}"`);
    expect(html).not.toContain("form-secret");
    expect(html).not.toContain("response-secret");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("provider body");
  });

  it("surfaces sanitized durable provider retry state after reload", async () => {
    operationBody = durableOperation("provider_unavailable");
    const html = await (await (await build()).request("/integrations?principalOp=op_public")).text();
    expect(html).toContain("provider verification unavailable");
    expect(html).toContain("sentry_scope_http_503");
    expect(html).toContain("2030-01-02T03:04:05.000Z");
    expect(html).not.toContain("linked sentry");
  });

  it("rejects hostile durable diagnostics from visible chrome", async () => {
    operationBody = {
      ...durableOperation("provider_unavailable"),
      failureClassification: "<script>provider body</script>",
      retryAfter: "javascript:alert(1)",
    };
    const html = await (await (await build()).request("/integrations?principalOp=op_public")).text();
    expect(html).toContain("provider verification unavailable");
    expect(html).not.toContain("provider body");
    expect(html).not.toContain("javascript:alert");
  });

  it.each(selectionOutcomes)(
    "continues selected-principal $wire as $expected without false success",
    async ({ wire, expected, success }) => {
      selectionBody = {
        ...(wire === undefined ? {} : { status: wire }),
        operationId: "op_public",
        operationUrl: "javascript:alert(1)",
        token: "response-secret",
      };
      operationBody = durableOperation(["malformed", "unknown", "failed"].includes(expected) ? "completed" : expected);
      const response = await selectPrincipal();
      const location = response.headers.get("location") ?? "";
      expect(response.status).toBe(303);
      expect(location).toContain("principalOp=op_public");
      expect(location).toContain(`principalStatus=${expected}`);
      expect(location.includes("principal%20selected")).toBe(success);
      expect(location).not.toContain("response-secret");
      expect(location).not.toContain("javascript");

      const html = await (await (await build()).request(location)).text();
      expect(html).toContain(`data-principal-status="${expected}"`);
      expect(html).not.toContain("response-secret");
      expect(html).not.toContain("javascript:alert");
    },
  );

  it("fails mismatched and missing operation identity closed on the submitted durable coordinate", async () => {
    for (const hostileBody of [
      { status: "completed", operationId: "javascript:alert(1)", token: "response-secret" },
      { status: "completed", token: "response-secret" },
    ]) {
      selectionBody = hostileBody;
      const response = await selectPrincipal();
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("principalOp=op_public");
      expect(location).toContain("principalStatus=" + ("operationId" in hostileBody ? "invalidated" : "malformed"));
      expect(location).not.toContain("principal%20selected");
      expect(location).not.toContain("javascript");
      expect(location).not.toContain("response-secret");
    }
  });

  it.each([
    { kind: "conflict", expected: "invalidated", status: 409, transport: false },
    { kind: "http failure", expected: "failed", status: 503, transport: false },
    { kind: "transport failure", expected: "unavailable", status: 202, transport: true },
  ])("keeps the operation resumable after $kind", async ({ expected, status, transport }) => {
    selectionStatus = status;
    selectionTransportFailure = transport;
    selectionBody = { error: "hostile <script>", operationId: "other-operation" };
    const location = (await selectPrincipal()).headers.get("location") ?? "";
    expect(location).toContain("principalOp=op_public");
    expect(location).toContain(`principalStatus=${expected}`);
    expect(location).not.toContain("other-operation");
    expect(location).not.toContain("script");
    expect(location).not.toContain("principal%20selected");
  });
});
