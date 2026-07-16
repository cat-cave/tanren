import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountBehaviorCoverageScreen } from "../src/routes/behaviorCoverage/index.js";

const CONTENT_DIGEST = `sha256:${"a".repeat(64)}`;
const ANALYSIS_ID = `sha256:${"b".repeat(64)}`;
const HEAD_SHA = "c".repeat(40);
const MEMBER_KEY = "d".repeat(64);
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
const SELECTION = {
  version: "v1",
  analysisId: ANALYSIS_ID,
  orgId: "org_acme",
  projectId: "project_easy",
  binding: {
    integrationNodeId: "integration_node_visible",
    baseSha: "0".repeat(40),
    preparedHeadSha: HEAD_SHA,
    treeHash: "tree_visible",
    memberKey: MEMBER_KEY,
  },
  mode: "expanded_unknown",
  changedTargets: [{ kind: "source", targetRef: "src/unknown.ts" }],
  unknownTargets: [{ kind: "source", targetRef: "src/unknown.ts" }],
  selected: [
    {
      behaviorRevisionId: "behavior_revision_login",
      reasons: [{ kind: "unknown_target", target: { kind: "source", targetRef: "src/unknown.ts" } }],
    },
    {
      behaviorRevisionId: "behavior_revision_checkout",
      reasons: [
        { kind: "unknown_target", target: { kind: "source", targetRef: "src/unknown.ts" } },
        { kind: "uncovered_behavior" },
      ],
    },
  ],
  excluded: [],
} as const;

const AVAILABLE_GRAPH = {
  status: "available",
  behaviors: [
    {
      behaviorRevisionId: "behavior_revision_login",
      contentDigest: CONTENT_DIGEST,
      title: "operator can sign in",
      edges: [{ id: "coverage_edge_login", kind: "source", targetRef: "src/login.ts" }],
    },
    {
      behaviorRevisionId: "behavior_revision_checkout",
      contentDigest: `sha256:${"e".repeat(64)}`,
      title: "checkout completes",
      edges: [],
    },
  ],
  uncoveredBehaviorRevisionIds: ["behavior_revision_checkout"],
} as const;

let graphUnavailable = false;
let serviceUnavailable = false;
let selectionUnavailable = false;
let verifyState: "current" | "stale" = "current";
let writeHeaders: Headers | undefined;
let writeBody: unknown;
let latestSelection: unknown = SELECTION;

function overview(): unknown {
  return {
    version: "v1",
    orgId: "org_acme",
    projectId: "project_easy",
    graph: graphUnavailable ? { status: "unavailable" } : AVAILABLE_GRAPH,
    latestSelection: { status: "available", selection: latestSelection },
  };
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf_visible", expiresAt: "2030-01-01" }));
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }));
    if (url.endsWith("/orgs/org_acme/projects")) {
      return new Response(JSON.stringify({ projects: PROJECTS }));
    }
    if (url.endsWith("/behavior-coverage/affected-selection") && method === "POST") {
      writeHeaders = new Headers(init?.headers);
      writeBody = JSON.parse(String(init?.body));
      return selectionUnavailable
        ? new Response(JSON.stringify({ error: "affected_selection_unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ selection: SELECTION }), { status: 201 });
    }
    if (decodeURIComponent(url).endsWith(`/${ANALYSIS_ID}/verify`) && method === "POST") {
      writeHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ verification: { status: verifyState, analysisId: ANALYSIS_ID } }), {
        status: verifyState === "current" ? 200 : 409,
      });
    }
    if (url.endsWith("/behavior-coverage")) {
      return serviceUnavailable
        ? new Response(JSON.stringify({ error: "behavior_coverage_unavailable" }), { status: 503 })
        : new Response(JSON.stringify(overview()));
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  graphUnavailable = false;
  serviceUnavailable = false;
  selectionUnavailable = false;
  verifyState = "current";
  writeHeaders = undefined;
  writeBody = undefined;
  latestSelection = SELECTION;
  mockOrchestrator();
});

afterEach(() => vi.unstubAllGlobals());

function build(): Hono {
  const app = new Hono();
  mountBehaviorCoverageScreen(app, { orchestratorUrl: "http://orchestrator" });
  return app;
}

function post(path: string, fields: Record<string, string>): Promise<Response> {
  return build().request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("rv-4 visible behavior coverage surface", () => {
  it("renders the persisted graph, revision digests, binding, and latest durable fact", async () => {
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("behavior coverage");
    expect(html).toContain("operator can sign in");
    expect(html).toContain(CONTENT_DIGEST);
    expect(html).toContain("src/login.ts");
    expect(html).toContain("uncovered · fail-closed");
    expect(html).toContain(ANALYSIS_ID);
    expect(html).toContain(HEAD_SHA);
    expect(html).toContain("integration_node_visible");
  });

  it("keeps the durable fact visible when the current graph is unavailable", async () => {
    graphUnavailable = true;
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("Current graph unavailable");
    expect(html).toContain(ANALYSIS_ID);
    expect(html).not.toContain("persisted edges</span>");
  });

  it("renders total service failure without fabricating zero coverage", async () => {
    serviceUnavailable = true;
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("Coverage service unavailable");
    expect(html).not.toContain("0</b><span>active behaviors");
  });

  it("fails loudly instead of letting a contradictory targeted mode hide widening", async () => {
    latestSelection = { ...SELECTION, mode: "targeted" };
    const html = await (await build().request("/projects/project_easy/behavior-coverage")).text();
    expect(html).toContain("Coverage service unavailable");
    expect(html).not.toContain(`data-analysis-id="${ANALYSIS_ID}"`);
    expect(html).not.toContain("excluded with proof");
  });

  it("posts the exact integration node and target, forwards CSRF, and explains widening", async () => {
    const response = await post("/projects/project_easy/behavior-coverage/analyze", {
      integrationNodeId: "integration_node_visible",
      targetKind: "source",
      targetRef: "src/unknown.ts",
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(writeHeaders?.get("x-csrf-token")).toBe("csrf_visible");
    expect(writeBody).toEqual({
      integrationNodeId: "integration_node_visible",
      targets: [{ kind: "source", targetRef: "src/unknown.ts" }],
    });
    expect(html).toContain(ANALYSIS_ID);
    expect(html).toContain("expanded unknown");
    expect(html).toContain("No behavior was skipped on an unknown");
  });

  it("withholds a selection when the durable write fails", async () => {
    selectionUnavailable = true;
    const response = await post("/projects/project_easy/behavior-coverage/analyze", {
      integrationNodeId: "integration_node_visible",
      targetKind: "source",
      targetRef: "src/unknown.ts",
    });
    const html = await response.text();
    expect(html).toContain("did not persist an affected-selection fact");
    expect(html.match(new RegExp(`data-analysis-id="${ANALYSIS_ID}"`, "gu"))?.length).toBe(1);
  });

  it("visibly distinguishes current and stale exact-bound replay", async () => {
    const current = await post("/projects/project_easy/behavior-coverage/verify", { analysisId: ANALYSIS_ID });
    expect(await current.text()).toContain("Selection is current for its exact graph");
    expect(writeHeaders?.get("x-csrf-token")).toBe("csrf_visible");

    verifyState = "stale";
    const stale = await post("/projects/project_easy/behavior-coverage/verify", { analysisId: ANALYSIS_ID });
    expect(await stale.text()).toContain("Selection is stale");
  });

  it("does not query or display another project through a path parameter", async () => {
    const html = await (await build().request("/projects/project_other/behavior-coverage")).text();
    expect(html).toContain("This project is not visible in the active organization");
    expect(html).not.toContain(ANALYSIS_ID);
  });
});
