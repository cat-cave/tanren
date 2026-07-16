// Org integrations two-plane panel rendered-HTML tests. Mirrors the
// merge-queue / DORA harness: build the app with a stubbed pool + a mocked
// orchestrator (global fetch), then assert the rendered /integrations screen.
//
// Coverage:
//   - /integrations mounts the real screen (not the placeholder);
//   - full linked state renders grant cards + ready enable buttons;
//   - empty / not_linked 200 path surfaces the link-first affordance;
//   - read failure → "unavailable" (no fabricated empty grant/project list);
//   - project-scoped writes require fresh list membership + exact project read.

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
const PROJECT_DETAIL = { ...PROJECTS[0], config: {} };

const LINKED_INTEGRATIONS = {
  integrations: [
    {
      connectionId: "connection_sentry",
      grantId: "grant_sentry",
      orgId: "org_acme",
      providerKind: "sentry",
      providerPrincipalId: "sentry_acme",
      principalKind: "organization",
      displayName: "Acme Sentry",
      health: "healthy",
      connectionStatus: "active",
      currentAuthGeneration: 2,
      grantGeneration: 3,
      grantStatus: "active",
      providerScopes: [],
      selectedForProject: true,
    },
    {
      connectionId: "connection_slack",
      grantId: "grant_slack",
      orgId: "org_acme",
      providerKind: "slack",
      providerPrincipalId: "workspace_acme",
      principalKind: "team",
      displayName: "Acme Slack",
      health: "healthy",
      connectionStatus: "active",
      currentAuthGeneration: 1,
      grantGeneration: 1,
      grantStatus: "active",
      providerScopes: ["chat:write"],
      selectedForProject: true,
    },
    {
      connectionId: "connection_vercel",
      grantId: "grant_vercel",
      orgId: "org_acme",
      providerKind: "deploy.vercel",
      providerPrincipalId: "team_abc",
      principalKind: "team",
      displayName: "Acme Vercel",
      health: "unknown",
      connectionStatus: "active",
      currentAuthGeneration: 1,
      grantGeneration: 1,
      grantStatus: "active",
      providerScopes: [],
      selectedForProject: false,
    },
  ],
  lifecycle: {
    projectId: "project_easy",
    requirements: { total: 2, needsAttention: 1 },
    capabilityNodes: { total: 3, awaitingGrant: 1, ready: 1, needsAttention: 1 },
    bindings: { total: 1, ready: 1, drifted: 0, needsAttention: 0 },
    deliveries: { total: 1, completed: 1, degraded: 0, needsAttention: 0 },
  },
};

const EMPTY_INTEGRATIONS = { integrations: [] };

type ListMode = "linked" | "empty" | "fail";
let listMode: ListMode = "linked";
type ProjectListMode = "selected" | "empty" | "fail";
type ProjectReadMode = "ok" | "malformed" | "non200";
let projectListMode: ProjectListMode = "selected";
let projectReadMode: ProjectReadMode = "ok";
let projectDetailReads = 0;
let provisionWrites = 0;
let selectionWrites = 0;
/** Scripted provision response for the enable POST path. */
let provisionBody: unknown = { status: "provisioned", capability: "errors", providerKind: "sentry" };
let provisionStatus = 201;

function stubPool(): Pool {
  const pool = new Pool();
  vi.spyOn(pool, "query").mockResolvedValue({
    rows: [{ ok: 1 }],
    rowCount: 1,
    command: "SELECT",
    oid: 0,
    fields: [],
  });
  return pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }

    // Integrations paths MUST be matched before the generic /projects fallback
    // (project-scoped provision/discover paths also contain "/projects").
    if (/\/orgs\/[^/]+\/integrations(\?|$)/u.test(url) && method === "GET") {
      if (listMode === "fail") {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(listMode === "linked" ? LINKED_INTEGRATIONS : EMPTY_INTEGRATIONS), {
        status: 200,
      });
    }
    if (/\/orgs\/[^/]+\/integrations\/[^/]+$/u.test(url) && method === "POST") {
      // link
      return new Response(
        JSON.stringify({
          status: "linked",
          providerKind: "sentry",
          connectionId: "connection_sentry",
          grantId: "grant_sentry",
          authGeneration: 1,
          grantGeneration: 1,
          capabilities: ["errors"],
          metadataKeys: [],
        }),
        { status: 201 },
      );
    }
    if (/\/integrations\/provision/u.test(url) && method === "POST") {
      provisionWrites += 1;
      return new Response(JSON.stringify(provisionBody), { status: provisionStatus });
    }
    if (/\/integrations\/[^/]+\/selection$/u.test(url) && method === "PUT") {
      selectionWrites += 1;
      return new Response(
        JSON.stringify({
          status: "selected",
          providerKind: "deploy.vercel",
          connectionId: "connection_vercel",
          grantId: "grant_vercel",
          upstreamAccountId: "team_abc",
          authGeneration: 1,
          grantGeneration: 1,
        }),
        { status: 200 },
      );
    }
    if (/\/integrations\/discover/u.test(url)) {
      // not_linked is a 200 — branch on body.status.
      return new Response(
        JSON.stringify({
          status: "not_linked",
          capability: "errors",
          providerKind: "sentry",
          message: "link sentry at the org level first.",
          linkAffordance: { kind: "org_integration_link", providerKind: "sentry", orgId: "org_acme" },
        }),
        { status: 200 },
      );
    }

    const pathname = new URL(url).pathname;
    if (/\/orgs\/[^/]+\/projects\/[^/]+$/u.test(pathname) && method === "GET") {
      projectDetailReads += 1;
      const body = projectReadMode === "malformed" ? { projectId: PROJECTS[0]?.projectId } : PROJECT_DETAIL;
      return new Response(JSON.stringify(body), { status: projectReadMode === "non200" ? 201 : 200 });
    }
    if (/\/orgs\/[^/]+\/projects$/u.test(pathname) && method === "GET") {
      if (projectListMode === "fail") return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ projects: projectListMode === "empty" ? [] : PROJECTS }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  listMode = "linked";
  projectListMode = "selected";
  projectReadMode = "ok";
  projectDetailReads = 0;
  provisionWrites = 0;
  selectionWrites = 0;
  provisionBody = { status: "provisioned", capability: "errors", providerKind: "sentry" };
  provisionStatus = 201;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("integrations two-plane panel (/integrations)", () => {
  it("mounts the real screen, not a placeholder", async () => {
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("link once, enable per project");
    expect(html).not.toContain("documented placeholder");
  });

  it("renders the full linked state with grant cards and ready enable actions", async () => {
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("plane a · org grants");
    expect(html).toContain("plane b · project enable");
    // Linked providers surface as authority cards without credential refs or values.
    expect(html).toContain('data-provider="sentry"');
    expect(html).toContain('data-provider="slack"');
    expect(html).toContain('data-provider="deploy.vercel"');
    expect(html).not.toContain("secret://org/");
    expect(html).toContain("verified principal · Acme Sentry");
    // Principal IDs and generation numbers never appear in visible chrome.
    expect(html).not.toContain("sentry_acme");
    expect(html).not.toContain("workspace_acme");
    expect(html).not.toContain("team_abc");
    // Generation numbers are internal eligibility coordinates — never operator UI.
    expect(html).not.toContain("auth generation");
    expect(html).not.toContain("grant generation");
    expect(html).toContain("scopes · chat:write");
    expect(html).toContain("selected for project");
    expect(html).toContain("use this principal");
    // Only explicitly selected capabilities show ready state + enable form.
    expect(html).toContain('data-capability="errors"');
    expect(html).toContain("account selected");
    expect(html).toContain('action="/integrations/enable"');
    // Org-admin link form is present.
    expect(html).toContain("data-link-form");
    // IN-1 foundation is visible as truthful persisted-state counts.
    expect(html).toContain("data-lifecycle-inventory");
    expect(html).toContain('data-lifecycle-kind="requirements"');
    expect(html).toContain("1 need attention");
    // Hetzner stays out of scope.
    expect(html).not.toContain("hetzner");
  });

  it("proxies an exact account selection and renders selection-required truthfully", async () => {
    const app = await build();
    const selected = await app.request("/integrations/select", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&providerKind=deploy.vercel&connectionId=connection_vercel&grantId=grant_vercel&authGeneration=1&grantGeneration=1",
    });
    expect(selected.status).toBe(303);
    expect(selected.headers.get("location")).toContain("selected%20deploy.vercel%20principal");
    expect(selectionWrites).toBe(1);

    provisionBody = {
      status: "selection_required",
      capability: "errors",
      providerKind: "sentry",
      reason: "selected_grant_unavailable",
      message: "choose an active sentry account",
      candidates: [],
    };
    provisionStatus = 409;
    const response = await app.request("/integrations/enable", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&capability=errors&providerKind=sentry",
    });
    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(303);
    expect(provisionWrites).toBe(1);
    expect(projectDetailReads).toBe(2);
    expect(location).toContain("selectionRequired=sentry");
    const html = await (await app.request(location)).text();
    expect(html).toContain('data-selection-required="sentry"');
    expect(html).toContain("choose an active sentry account");
  });

  it("renders empty plane-a copy when nothing is linked (not an error)", async () => {
    listMode = "empty";
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("data-integrations-empty");
    expect(html).toContain("No providers linked yet");
    // Enable buttons for unlinked providers are disabled (not linked).
    expect(html).toContain("not linked");
    expect(html).not.toContain("data-integrations-unavailable");
  });

  it("renders a legitimate empty project set without claiming projects are unavailable", async () => {
    projectListMode = "empty";
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("No project visible; lifecycle state is not applicable.");
    expect(html).toContain("No project visible yet. Onboard one");
    expect(html).not.toContain("data-projects-unavailable");
    expect(html).not.toContain('action="/integrations/enable"');
    expect(html).not.toContain('action="/integrations/select"');
  });

  it("renders project-list failure explicitly and performs zero project-scoped writes", async () => {
    projectListMode = "fail";
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("data-projects-unavailable");
    expect(html).toContain("Projects unavailable — lifecycle state cannot be scoped safely.");
    expect(html).toContain("Capability enable is paused while projects are unavailable.");
    expect(html).not.toContain("No project visible; lifecycle state is not applicable.");

    await app.request("/integrations/select", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&providerKind=deploy.vercel&connectionId=connection_vercel&grantId=grant_vercel&authGeneration=1&grantGeneration=1",
    });
    await app.request("/integrations/enable", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&capability=errors&providerKind=sentry",
    });
    expect(projectDetailReads).toBe(0);
    expect(selectionWrites).toBe(0);
    expect(provisionWrites).toBe(0);
  });

  it("rejects a foreign form project id before exact reads or project-scoped writes", async () => {
    const app = await build();
    const selected = await app.request("/integrations/select", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_foreign&providerKind=deploy.vercel&connectionId=connection_vercel&grantId=grant_vercel&authGeneration=1&grantGeneration=1",
    });
    const enabled = await app.request("/integrations/enable", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_foreign&capability=errors&providerKind=sentry",
    });
    expect(selected.headers.get("location")).toContain("project%20unavailable%20or%20not%20visible");
    expect(enabled.headers.get("location")).toContain("project%20unavailable%20or%20not%20visible");
    expect(projectDetailReads).toBe(0);
    expect(selectionWrites).toBe(0);
    expect(provisionWrites).toBe(0);
  });

  it.each(["malformed", "non200"] as const)(
    "rejects %s exact-project reads before either project-scoped write",
    async (mode) => {
      projectReadMode = mode;
      const app = await build();
      await app.request("/integrations/select", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "projectId=project_easy&providerKind=deploy.vercel&connectionId=connection_vercel&grantId=grant_vercel&authGeneration=1&grantGeneration=1",
      });
      await app.request("/integrations/enable", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "projectId=project_easy&capability=errors&providerKind=sentry",
      });
      expect(projectDetailReads).toBe(2);
      expect(selectionWrites).toBe(0);
      expect(provisionWrites).toBe(0);
    },
  );

  it("surfaces the not_linked 200 path as a link-first affordance (not an error)", async () => {
    // Simulate a prior enable that returned status:not_linked (HTTP 200).
    const app = await build();
    const html = await (
      await app.request("/integrations?notLinked=sentry&notLinkedMsg=link%20sentry%20at%20the%20org%20level%20first.")
    ).text();
    expect(html).toContain('data-not-linked="sentry"');
    expect(html).toContain("not linked");
    expect(html).toContain("link sentry at the org level first.");
    // Still mounts the real screen — not a crash / 5xx page.
    expect(html).toContain("link once, enable per project");
  });

  it("enable POST with not_linked 200 redirects to the link-first affordance", async () => {
    listMode = "empty";
    provisionBody = {
      status: "not_linked",
      capability: "errors",
      providerKind: "sentry",
      message: "link sentry at the org level first.",
      linkAffordance: { kind: "org_integration_link", providerKind: "sentry", orgId: "org_acme" },
    };
    provisionStatus = 200;
    const app = await build();
    const res = await app.request("/integrations/enable", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&capability=errors&providerKind=sentry",
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/integrations?");
    expect(location).toContain("notLinked=sentry");
    // Follow the redirect and assert the affordance renders.
    const html = await (await app.request(location)).text();
    expect(html).toContain('data-not-linked="sentry"');
  });

  it("renders 'unavailable', not a fabricated empty grant list, when the list read fails", async () => {
    listMode = "fail";
    const app = await build();
    const html = await (await app.request("/integrations")).text();
    expect(html).toContain("data-integrations-unavailable");
    expect(html).toContain("Integrations unavailable");
    // Must NOT render the "no providers linked yet" empty state or fake grants.
    expect(html).not.toContain("data-integrations-empty");
    expect(html).not.toContain("secret://org/");
    expect(html).not.toContain("data-link-form");
  });
});
