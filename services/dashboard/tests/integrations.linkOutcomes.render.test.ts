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
    if (/\/integrations\/operations\/op_public$/u.test(path) && method === "GET") {
      return Response.json(operationBody);
    }
    if (/\/orgs\/org_acme\/integrations\/sentry$/u.test(path) && method === "POST") {
      return Response.json(linkBody, { status: 202 });
    }
    if (/\/orgs\/org_acme\/integrations$/u.test(path) && method === "GET") {
      return Response.json({ integrations: [] });
    }
    if (/\/orgs\/org_acme\/projects$/u.test(path) && method === "GET") {
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
});
