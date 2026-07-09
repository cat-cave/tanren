// Inbound browser→dashboard CSRF gate for cookie-authenticated BFF writes.
//
// Without this gate the BFF mints orchestrator x-csrf-token from /auth/me for
// any cookie-authenticated POST — a CSRF-token minting proxy. These tests pin
// reject (missing/wrong) and accept (header + form field) paths.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECTS = [
  {
    projectId: "project_easy",
    name: "tanren-fixture-easy",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];

const SESSION_COOKIE = "tanren_session=sess-inbound-csrf";
const CSRF = "csrf-secret-token-aaaaaaaa";

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let putCount = 0;
let lastPutHeaders: Record<string, string> | undefined;
let forgeToolsCount = 0;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers["cookie"] ?? headers["Cookie"] ?? "";

    if (url.endsWith("/auth/me")) {
      // Mirror real orchestrator: session requires cookie.
      if (!cookie.includes("tanren_session=")) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      }
      return new Response(JSON.stringify({ userId: "u1", csrfToken: CSRF, expiresAt: "2030-01-01T00:00:00.000Z" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (/\/projects\/[^/]+\/budget(\?|$)/u.test(url) && method === "PUT") {
      putCount += 1;
      lastPutHeaders = headers;
      return new Response(
        JSON.stringify({
          ceilingUsd: 10,
          period: "monthly",
          spentUsd: 0,
          notionalUsd: 0,
          remainingUsd: 10,
          paused: false,
          failClosed: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/budget")) {
      return new Response(
        JSON.stringify({
          ceilingUsd: 50,
          period: "monthly",
          spentUsd: 0,
          notionalUsd: 0,
          remainingUsd: 50,
          paused: false,
          failClosed: null,
        }),
        { status: 200 },
      );
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    }
    if (url.includes("/forge/tools") && method === "POST") {
      forgeToolsCount += 1;
      return new Response(JSON.stringify({ tool: "t", result: { ok: true } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env["TANREN_REQUIRE_AUTH"];
  putCount = 0;
  lastPutHeaders = undefined;
  forgeToolsCount = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["TANREN_REQUIRE_AUTH"];
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("inbound BFF CSRF (cookie-authenticated writes)", () => {
  it("rejects form POST with session cookie but missing csrf (403, no orchestrator write)", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "action=save&ceilingUsd=10&period=monthly&projectId=project_easy",
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("csrf_token_invalid");
    expect(putCount).toBe(0);
  });

  it("rejects form POST with wrong csrf token (403, no orchestrator write)", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=wrong-token&action=save&ceilingUsd=10&period=monthly&projectId=project_easy`,
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_token_invalid");
    expect(putCount).toBe(0);
  });

  it("accepts form POST with matching csrf form field and forwards outbound CSRF", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${CSRF}&action=save&ceilingUsd=10&period=monthly&projectId=project_easy`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("ok=saved");
    expect(putCount).toBe(1);
    expect(lastPutHeaders?.["x-csrf-token"]).toBe(CSRF);
  });

  it("accepts form POST with matching x-csrf-token header", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": CSRF,
      },
      body: "action=save&ceilingUsd=10&period=monthly&projectId=project_easy",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("ok=saved");
    expect(putCount).toBe(1);
  });

  it("rejects JSON island POST with session cookie but missing csrf header", async () => {
    const app = await build();
    const res = await app.request("/forge/tools", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ orgId: "org_acme", tool: "tanren.noop", args: {} }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_token_invalid");
    expect(forgeToolsCount).toBe(0);
  });

  it("accepts JSON island POST with matching x-csrf-token header", async () => {
    const app = await build();
    const res = await app.request("/forge/tools", {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        "content-type": "application/json",
        "x-csrf-token": CSRF,
      },
      body: JSON.stringify({ orgId: "org_acme", tool: "tanren.noop", args: {} }),
    });
    expect(res.status).toBe(200);
    expect(forgeToolsCount).toBe(1);
  });

  it("skips inbound CSRF when no session cookie (local-dev / unauthenticated path)", async () => {
    // Existing render tests post without cookies; the gate must not break them.
    // Real /auth/me 401s without a cookie — no expected token ⇒ skip gate.
    const app = await build();
    const res = await app.request("/budget", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=save&ceilingUsd=10&period=monthly&projectId=project_easy",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("ok=saved");
    expect(putCount).toBe(1);
  });

  it("GET remains CSRF-exempt with a session cookie", async () => {
    const app = await build();
    const res = await app.request("/budget", {
      headers: { cookie: SESSION_COOKIE },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Server-rendered form embeds the hidden csrf field for pure HTML posts.
    expect(html).toContain('name="csrf"');
    expect(html).toContain(CSRF);
  });
});
