// Failure-truth for project pages: unavailable ≠ empty, partial success kept.
// Stubs orchestrator via global fetch; asserts markers rather than fabricated zeros.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";
import { buildProjectViewModel } from "../src/components/project/projectViewData.js";

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

const FEED = [
  {
    ts: "2026-05-28T10:05:00.000Z",
    runId: "r_live",
    eventType: "run.started",
    specId: "s_live",
  },
];

function baseFetch(url: string, method: string): Response | undefined {
  if (url.endsWith("/auth/me"))
    return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
      status: 200,
    });
  if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
  if (/\/orgs\/[^/]+\/projects$/u.test(url) && method === "GET")
    return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
  if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
  return undefined;
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true, orchestratorUrl: "http://orch.test" });
}

describe("project page failure truth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chat-primary marks KPI/activity/attention unavailable when runs+feed fail (not zeros)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.includes("/runs")) return new Response(JSON.stringify({ error: "runs_down" }), { status: 503 });
      if (url.includes("/feed")) return new Response(JSON.stringify({ error: "feed_down" }), { status: 503 });
      if (url.includes("/insights")) return new Response(JSON.stringify({ insights: [] }), { status: 200 });
      if (url.includes("/milestones")) return new Response(JSON.stringify({ milestones: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const res = await app.request("/projects/project_easy");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("data-kpi-unavailable");
    expect(html).toContain("data-activity-unavailable");
    expect(html).toContain("Activity unavailable");
    expect(html).toContain("data-runs-unavailable");
    // Attention must not collapse to idle-empty when runs are unavailable.
    expect(html).toContain('data-attention-panel="unavailable"');
    expect(html).toContain("data-attention-unavailable");
    expect(html).not.toContain("data-attention-empty");
    expect(html).not.toContain("Nothing needs you right now");
    expect(html).not.toContain("0 things need you");
    // Must not claim fabricated week spend $0 from a failed runs read.
    expect(html).not.toMatch(/week spend[\s\S]{0,80}\$0/u);
  });

  it("preserves good feed when only runs fail (partial success)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.includes("/runs")) return new Response(JSON.stringify({ error: "runs_down" }), { status: 503 });
      if (url.includes("/feed")) return new Response(JSON.stringify({ items: FEED }), { status: 200 });
      if (url.includes("/insights")) return new Response(JSON.stringify({ insights: [] }), { status: 200 });
      if (url.includes("/milestones")) return new Response(JSON.stringify({ milestones: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("data-kpi-unavailable");
    expect(html).not.toContain("data-activity-unavailable");
    expect(html).toContain("run started");
  });

  it("DAG-unavailable page does not pair zeros from collapsed side reads", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.includes("/runs")) return new Response(JSON.stringify({ error: "runs_down" }), { status: 503 });
      if (url.includes("/feed")) return new Response(JSON.stringify({ error: "feed_down" }), { status: 503 });
      if (url.includes("/insights")) return new Response(JSON.stringify({ error: "insights_down" }), { status: 503 });
      if (url.includes("/milestones"))
        return new Response(JSON.stringify({ error: "milestones_down" }), { status: 503 });
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ error: "specs_down" }), { status: 503 });
      if (url.includes("/personas")) return new Response(JSON.stringify({ personas: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const res = await app.request("/projects/project_easy?mode=dag");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("data-project-dag-unavailable");
    expect(html).toContain('role="alert"');
    expect(html).toContain("data-kpi-unavailable");
    expect(html).toContain("This is not an empty graph");
  });

  it("spec list marks unavailable when specs read fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ error: "specs_down" }), { status: 503 });
      if (url.includes("/runs")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs")).text();
    expect(html).toContain("data-specs-unavailable");
    expect(html).toContain("not an empty project");
    expect(html).not.toContain("No specs yet");
  });

  it("spec create distinguishes unavailable dependency picker from empty", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ error: "specs_down" }), { status: 503 });
      if (url.includes("/milestones"))
        return new Response(JSON.stringify({ error: "milestones_down" }), { status: 503 });
      if (url.includes("/personas")) return new Response(JSON.stringify({ personas: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/new")).text();
    expect(html).toContain("data-specs-unavailable");
    expect(html).toContain("data-milestones-unavailable");
    expect(html).toContain("— unavailable —");
    expect(html).not.toContain("no other specs to depend on yet");
  });

  it("spec create marks behaviors unavailable when personas read fails (not empty list)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const base = baseFetch(url, method);
      if (base !== undefined) return base;
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ specs: [] }), { status: 200 });
      if (url.includes("/milestones")) return new Response(JSON.stringify({ milestones: [] }), { status: 200 });
      if (url.includes("/personas")) return new Response(JSON.stringify({ error: "personas_down" }), { status: 503 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/new")).text();
    expect(html).toContain("data-behaviors-unavailable");
    expect(html).not.toContain("data-behaviors-empty");
    expect(html).not.toContain("no behaviors defined for this project yet");
  });
});

describe("buildProjectViewModel availability", () => {
  it("emits unavailable KPIs and attention when sources fail", () => {
    const model = buildProjectViewModel({
      projectId: "p",
      projectName: "P",
      runs: undefined,
      insights: undefined,
      milestones: undefined,
      feed: undefined,
      narration: undefined,
      weekSpendUsd: undefined,
    });
    expect(model.runsUnavailable).toBe(true);
    expect(model.attentionUnavailable).toBe(true);
    expect(model.activityUnavailable).toBe(true);
    expect(model.kpis.every((k) => k.unavailable === true)).toBe(true);
    expect(model.activity).toEqual([]);
    expect(model.attention).toEqual([]);
    expect(model.liveLabel).toContain("unavailable");
  });

  it("keeps feed-derived activity when only runs fail", () => {
    const model = buildProjectViewModel({
      projectId: "p",
      projectName: "P",
      runs: undefined,
      insights: [],
      milestones: [],
      feed: [{ ts: "2026-01-01T00:00:00.000Z", runId: "r1", eventType: "run.started", specId: null }],
      narration: undefined,
      weekSpendUsd: undefined,
    });
    expect(model.runsUnavailable).toBe(true);
    expect(model.attentionUnavailable).toBe(true);
    expect(model.activityUnavailable).toBe(false);
    expect(model.activity).toHaveLength(1);
    expect(model.kpis.find((k) => k.k === "in-flight runs")?.unavailable).toBe(true);
  });
});
