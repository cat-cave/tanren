// rendered-HTML assertions for the DAG-primary project view, the
// chat↔DAG toggle, the spec-drawer fragment, and the full-page spec view.
// Mirrors the projects.render.test pattern: stub the pg pool + mock the
// orchestrator product APIs via global fetch, then assert the rendered screens.

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
const PROJECT = {
  projectId: "project_easy",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

const SPECS = [
  {
    specId: "s_done",
    projectId: "project_easy",
    title: "auth schema",
    description: "auth",
    acceptanceCriteria: ["a"],
    dependsOn: [],
    status: "merged",
  },
  {
    specId: "s_live",
    projectId: "project_easy",
    title: "orders schema",
    description: "orders",
    acceptanceCriteria: ["b"],
    dependsOn: ["s_done"],
    status: "in_flight",
  },
  {
    specId: "s_review",
    projectId: "project_easy",
    title: "supplier scorecard",
    description: "scorecard",
    acceptanceCriteria: ["renders table", "exports csv"],
    dependsOn: ["s_live"],
    status: "review",
  },
  {
    specId: "s_blocked",
    projectId: "project_easy",
    title: "edi mapping ui",
    description: "map edi documents",
    acceptanceCriteria: ["maps fields"],
    dependsOn: ["s_review"],
    status: "blocked",
  },
];

const RUNS = [
  {
    runId: "r_live",
    specId: "s_live",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "running",
    outcome: null,
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: null,
    prUrl: null,
    specTitle: "orders schema",
    costTotalUsd: "5.0",
    lastEventAt: "2026-05-28T10:05:00.000Z",
    needsReview: false,
  },
  {
    runId: "r_review",
    specId: "s_review",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "ok",
    startedAt: "2026-05-28T09:00:00.000Z",
    endedAt: "2026-05-28T09:30:00.000Z",
    prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/142",
    specTitle: "supplier scorecard",
    costTotalUsd: "12.0",
    lastEventAt: "2026-05-28T09:30:00.000Z",
    needsReview: true,
  },
  // Prior attempt for the same review-ready spec (run history depth).
  {
    runId: "r_review_prior",
    specId: "s_review",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "halted",
    startedAt: "2026-05-27T08:00:00.000Z",
    endedAt: "2026-05-27T08:20:00.000Z",
    prUrl: null,
    specTitle: "supplier scorecard",
    costTotalUsd: "4.0",
    lastEventAt: "2026-05-27T08:20:00.000Z",
    needsReview: false,
  },
  {
    runId: "r_blocked",
    specId: "s_blocked",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "halted",
    startedAt: "2026-05-28T08:00:00.000Z",
    endedAt: "2026-05-28T08:30:00.000Z",
    prUrl: null,
    specTitle: "edi mapping ui",
    costTotalUsd: "3.0",
    lastEventAt: "2026-05-28T08:30:00.000Z",
    needsReview: false,
  },
  // Unpriced / zero-cost run for sparse economics assertions.
  {
    runId: "r_done_unpriced",
    specId: "s_done",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "ok",
    startedAt: "2026-05-26T07:00:00.000Z",
    endedAt: "2026-05-26T07:15:00.000Z",
    prUrl: null,
    specTitle: "auth schema",
    costTotalUsd: "0",
    lastEventAt: "2026-05-26T07:15:00.000Z",
    needsReview: false,
  },
];

const MILESTONES = [
  {
    id: "m_7",
    projectId: "project_easy",
    label: "M7",
    name: "perf",
    description: null,
    orderIndex: 7,
    eta: "2026-06-18T00:00:00.000Z",
    status: "in_flight",
  },
];
const FEED = [
  {
    id: 10,
    ts: "2026-05-28T10:05:00.000Z",
    runId: "r_live",
    taskId: "task_1",
    specId: "s_live",
    projectId: "project_easy",
    eventType: "task.write.started",
    redactedPaths: [],
  },
];
const PERSONAS = [{ id: "persona_1", name: "buyer", description: "" }];
const BEHAVIORS = [{ id: "beh_1", personaId: "persona_1", title: "can export scorecard", description: null }];

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (url.endsWith("/projects/project_easy") && method === "GET")
      return new Response(JSON.stringify(PROJECT), { status: 200 });
    if (url.includes("/runs")) {
      // /runs?specId=… filters to that spec; otherwise all runs.
      const specMatch = /[?&]specId=([^&]+)/u.exec(url);
      const items = specMatch === null ? RUNS : RUNS.filter((r) => r.specId === decodeURIComponent(specMatch[1]));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (url.includes("/insights")) return new Response(JSON.stringify({ insights: [] }), { status: 200 });
    if (url.includes("/milestones")) return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
    if (url.includes("/feed")) return new Response(JSON.stringify({ items: FEED }), { status: 200 });
    if (url.endsWith("/specs") && method === "GET")
      return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    if (url.includes("/personas")) return new Response(JSON.stringify({ personas: PERSONAS }), { status: 200 });
    if (url.includes("/behaviors")) return new Response(JSON.stringify({ behaviors: BEHAVIORS }), { status: 200 });
    if (url.includes("/forge/threads") && url.endsWith("/threads"))
      return new Response(JSON.stringify({ id: "thread_1" }), { status: 201 });
    if (url.includes("/generate-project-view"))
      return new Response(JSON.stringify({ render: { body: "pulse", prompts: [] } }), {
        status: 201,
      });
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  mockOrchestrator();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("DAG-primary project view (?mode=dag)", () => {
  it("renders the DAG canvas island with nodes, edges, legend, and the group-by + zoom controls", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy?mode=dag")).text();
    expect(html).toContain('data-island="dag-canvas"');
    expect(html).toContain("the");
    expect(html).toContain("smithy");
    // a node per spec, click-routed via data-spec-id.
    expect(html).toContain('data-spec-id="s_review"');
    expect(html).toContain('data-spec-id="s_blocked"');
    // edges (dependency lines) + arrow markers.
    expect(html).toContain("dag-arr-hot");
    expect(html).toContain("<line");
    // legend with the five statuses + attention key.
    expect(html).toContain("legend");
    expect(html).toContain("attention #");
    // group-by + zoom controls.
    expect(html).toContain('data-group="milestone"');
    expect(html).toContain('data-group="behavior"');
    expect(html).toContain('data-group="priority"');
    expect(html).toContain('data-zoom="fit"');
  });

  it("renders numbered attention badges + the 'N need you' strip", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy?mode=dag")).text();
    // review (1) + blocked (2) + live (3) = 3 need you.
    expect(html).toContain("3 need you");
    expect(html).toContain("badge-num");
    expect(html).toContain("supplier scorecard");
  });

  it("offers the chat↔DAG toggle (dag active) with mode links", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy?mode=dag")).text();
    expect(html).toContain("data-mode-toggle");
    expect(html).toContain('data-mode-value="chat"');
    expect(html).toContain('data-mode-value="dag"');
    expect(html).toContain("/projects/project_easy?mode=chat");
  });

  it("defaults to chat-primary and honours the persisted mode cookie", async () => {
    const app = await build();
    const def = await (await app.request("/projects/project_easy")).text();
    expect(def).toContain("what needs");
    expect(def).not.toContain('data-island="dag-canvas"');
    const persisted = await (
      await app.request("/projects/project_easy", {
        headers: { cookie: "tanren_project_mode=dag" },
      })
    ).text();
    expect(persisted).toContain('data-island="dag-canvas"');
  });
});

describe("spec drawer fragment", () => {
  it("returns the drawer markup with status, acceptance, deps, latest run, and routing", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs/s_review/drawer");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("data-spec-drawer");
    expect(html).toContain("supplier scorecard");
    expect(html).toContain("review-ready");
    // acceptance criteria.
    expect(html).toContain("renders table");
    // depends-on chip (orders schema) + blocks chip (edi mapping ui).
    expect(html).toContain('data-spec-id="s_live"');
    expect(html).toContain('data-spec-id="s_blocked"');
    // latest run + review routing.
    expect(html).toContain("r_review");
    expect(html).toContain("/runs/r_review/review");
    // open-full-page escalation.
    expect(html).toContain("/projects/project_easy/specs/s_review");
  });

  it("renders the blocked reason for a blocked spec", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/s_blocked/drawer")).text();
    expect(html).toContain("why it");
    expect(html).toContain("blocked");
    expect(html).toContain("upstream dep");
  });

  it("404s a fragment for an unknown spec", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs/nope/drawer");
    expect(res.status).toBe(404);
  });
});

describe("spec full page", () => {
  it("renders the escalated full page with description, BDD, dependency chain, and run history", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/s_review")).text();
    expect(html).toContain("supplier scorecard");
    expect(html).toContain("description");
    expect(html).toContain("acceptance · bdd");
    expect(html).toContain("dependency chain");
    expect(html).toContain("run history");
    expect(html).toContain("r_review");
    // back-to-dag link.
    expect(html).toContain("/projects/project_easy?mode=dag");
  });

  it("pins full-data run-history + economics panels (spend, attempts, avg)", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/s_review")).text();
    // Panels present (data-* hooks for the full-page depth surface).
    expect(html).toContain("data-run-history-panel");
    expect(html).toContain("data-economics-section");
    expect(html).toContain("data-economics-panel");
    // Both attempts for this spec show in run history with priced cost labels.
    expect(html).toContain("r_review");
    expect(html).toContain("r_review_prior");
    expect(html).toContain("$12.00");
    expect(html).toContain("$4.00");
    // Economics: $12 + $4 = $16 spend, 2 attempts, $8 avg.
    expect(html).toContain("spend to date");
    expect(html).toContain("$16.00");
    expect(html).toContain("avg / attempt");
    expect(html).toContain("$8.00");
    expect(html).toContain("attempts");
    // When stamps from the run list are rendered (not raw ISO-only).
    expect(html).toContain("may 28");
    // No fabricated zero spend.
    expect(html).not.toContain("$0.00");
  });

  it("renders em-dash for unpriced economics, never fake zeros", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/s_done")).text();
    expect(html).toContain("run history");
    expect(html).toContain("r_done_unpriced");
    expect(html).toContain("economics");
    expect(html).toContain("spend to date");
    // Unpriced costTotalUsd "0" → "—", not "$0.00".
    expect(html).toContain("—");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("$0.0");
  });

  it("shows unavailable (not zeros) when the run-list read fails", async () => {
    // Override fetch so the runs endpoint 502s while specs still succeed.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      if (/\/orgs\/[^/]+\/projects$/u.test(url))
        return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
      if (url.endsWith("/projects/project_easy") && method === "GET")
        return new Response(JSON.stringify(PROJECT), { status: 200 });
      // Spec-scoped and project-wide run lists both fail.
      if (url.includes("/runs")) return new Response("upstream down", { status: 502 });
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
      if (url.includes("/milestones")) return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
      if (url.includes("/feed")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes("/insights")) return new Response(JSON.stringify({ insights: [] }), { status: 200 });
      if (url.includes("/personas")) return new Response(JSON.stringify({ personas: PERSONAS }), { status: 200 });
      if (url.includes("/behaviors")) return new Response(JSON.stringify({ behaviors: BEHAVIORS }), { status: 200 });
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    });

    const app = await build();
    const res = await app.request("/projects/project_easy/specs/s_review");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("supplier scorecard");
    expect(html).toContain("data-runs-unavailable");
    expect(html).toContain("data-economics-unavailable");
    expect(html).toContain("Run history unavailable");
    expect(html).toContain("Economics unavailable");
    // Must not fabricate empty-history or zero-dollar figures.
    expect(html).not.toContain("No runs yet");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("data-economics-panel");
  });

  it("does not shadow /specs/new", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/new")).text();
    expect(html).toContain('name="title"');
  });
});
