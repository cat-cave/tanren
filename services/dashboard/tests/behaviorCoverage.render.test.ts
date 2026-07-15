import { Hono } from "hono";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";
import { mountBehaviorCoverageScreen } from "../src/routes/behaviorCoverage/index.js";

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
    name: "fixture-easy",
    repoUrl: "https://github.com/cat-cave/fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];
const SNAPSHOT = {
  version: "v1",
  orgId: "org_acme",
  projectId: "project_easy",
  behaviors: [
    {
      behaviorRevisionId: "behavior_revision_login",
      title: "operator can sign in",
      edges: [{ id: "coverage_edge_login", kind: "source", targetRef: "src/login.ts" }],
    },
    { behaviorRevisionId: "behavior_revision_checkout", title: "checkout completes", edges: [] },
  ],
  uncoveredBehaviorRevisionIds: ["behavior_revision_checkout"],
};
const SELECTION = {
  version: "v1",
  analysisId: "coverage_selection_visible",
  orgId: "org_acme",
  projectId: "project_easy",
  mode: "expanded_unknown",
  changedTargets: [{ kind: "source", targetRef: "src/unknown.ts" }],
  unknownTargets: [{ kind: "source", targetRef: "src/unknown.ts" }],
  selected: [
    {
      behaviorRevisionId: "behavior_revision_login",
      reasons: [{ kind: "unknown_target", target: { kind: "source", targetRef: "src/unknown.ts" } }],
    },
    { behaviorRevisionId: "behavior_revision_checkout", reasons: [{ kind: "uncovered_behavior" }] },
  ],
  excluded: [],
};

let coverageUnavailable = false;
let selectionUnavailable = false;
let writeHeaders: Record<string, string> | undefined;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf_visible", expiresAt: "2030-01-01" }));
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }));
    if (url.endsWith("/behavior-coverage/affected-selection") && method === "POST") {
      writeHeaders = init?.headers as Record<string, string>;
      return selectionUnavailable
        ? new Response(JSON.stringify({ error: "affected_selection_unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ selection: SELECTION }), { status: 201 });
    }
    if (url.endsWith("/behavior-coverage")) {
      return coverageUnavailable
        ? new Response(JSON.stringify({ error: "behavior_coverage_unavailable" }), { status: 503 })
        : new Response(JSON.stringify(SNAPSHOT));
    }
    if (url.endsWith("/orgs/org_acme/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }));
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  coverageUnavailable = false;
  selectionUnavailable = false;
  writeHeaders = undefined;
  mockOrchestrator();
});

afterEach(() => vi.unstubAllGlobals());

function build(): Hono {
  const app = new Hono();
  mountBehaviorCoverageScreen(app, { orchestratorUrl: "http://orchestrator" });
  return app;
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

describe("rv-4 visible behavior coverage surface", () => {
  it("is registered in the production screen table and project navigation", async () => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const html = await (await app.request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("behavior coverage");
    expect(html).toContain('href="/projects/project_easy/behavior-coverage"');
    expect(html).not.toContain("documented placeholder");
  });

  it("renders the persisted matrix and marks uncovered behavior fail-closed", async () => {
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("behavior coverage");
    expect(html).toContain("operator can sign in");
    expect(html).toContain("src/login.ts");
    expect(html).toContain("uncovered · fail-closed");
    expect(html).toContain("analyze impact");
  });

  it("renders unavailable instead of fabricating zero coverage", async () => {
    coverageUnavailable = true;
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("Coverage facts unavailable");
    expect(html).not.toContain("persisted edges</span>");
  });

  it("posts the impact probe, forwards CSRF, and visibly explains unknown expansion", async () => {
    const response = await build().request("/projects/project_easy/behavior-coverage/analyze", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ targetKind: "source", targetRef: "src/unknown.ts" }).toString(),
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(writeHeaders?.["x-csrf-token"]).toBe("csrf_visible");
    expect(html).toContain("coverage_selection_visible");
    expect(html).toContain("expanded unknown");
    expect(html).toContain("No behavior was skipped on an unknown");
    expect(html).toContain("src/unknown.ts");
  });

  it("withholds a selection when the durable write fails", async () => {
    selectionUnavailable = true;
    const response = await build().request("/projects/project_easy/behavior-coverage/analyze", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ targetKind: "source", targetRef: "src/unknown.ts" }).toString(),
    });
    const html = await response.text();
    expect(html).toContain("did not persist an affected-selection fact");
    expect(html).not.toContain("coverage_selection_visible");
  });
});
