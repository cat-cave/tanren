// P3-0021 — rendered-HTML assertions for the scheduled-audits surface: the
// audit-job library (kind / cadence / window / last-run / findings + enable
// toggle), the window-fill bar, the forge-recommended coverage panel, and the
// new-audit composer. Mirrors the inbox.render pattern: stub the pg pool + mock
// the orchestrator APIs (incl. the audits snapshot) via global fetch, then
// assert the rendered screen + the composer/toggle/run POSTs.

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

const SNAPSHOT = {
  jobs: [
    {
      id: "audit_sec",
      orgId: "org_acme",
      projectId: null,
      kind: "security",
      name: "security scan",
      cadence: "nightly",
      targetWindow: "chatgpt · night (00–05)",
      answererCli: "claude · haiku-4.5",
      enabled: true,
      lastRun: null,
      findings: { count: 0, severity: "ok", note: "no new advisories" },
    },
    {
      id: "audit_a11y",
      orgId: "org_acme",
      projectId: "project_easy",
      kind: "a11y",
      name: "accessibility (a11y)",
      cadence: "weekly",
      targetWindow: "chatgpt · night (00–05)",
      answererCli: "claude · haiku-4.5",
      enabled: true,
      lastRun: "2026-05-26T04:00:00Z",
      findings: { count: 2, severity: "warn", note: "2 contrast issues → candidates" },
    },
    {
      id: "audit_mut",
      orgId: "org_acme",
      projectId: null,
      kind: "mutation",
      name: "mutation tests",
      cadence: "weekly",
      targetWindow: "self-host gpu (idle)",
      answererCli: "opencode · glm-5.1",
      enabled: false,
      lastRun: "2026-05-19T01:00:00Z",
      findings: { count: 0, severity: "off", note: "paused" },
    },
  ],
  recommended: [
    {
      kind: "perf",
      name: "performance budget",
      why: "perf milestones depend on a baseline.",
      window: "evening (20–00) · low fill",
      cadence: "nightly",
    },
    {
      kind: "license",
      name: "license compliance",
      why: "transitive deps change license class.",
      window: "night (00–05) · low fill",
      cadence: "weekly",
    },
  ],
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(snapshot: unknown = SNAPSHOT): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (/\/orgs\/[^/]+\/audits$/.test(url) && method === "GET")
      return new Response(JSON.stringify(snapshot), { status: 200 });
    if (/\/orgs\/[^/]+\/audits$/.test(url) && method === "POST")
      return new Response(JSON.stringify({ job: {} }), { status: 201 });
    if (/\/audits\/[^/]+\/(enable|disable|run)$/.test(url) && method === "POST")
      return new Response(JSON.stringify({ job: {} }), { status: 200 });
    // Costs gather → no runs, so the heatmap (window-fill) is empty.
    if (/\/runs(\?|$)/.test(url)) return new Response(JSON.stringify({ runs: [] }), { status: 200 });
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

describe("scheduled audits surface", () => {
  it("renders the page head, KPI counts, and the why-schedule pitch", async () => {
    const html = await (await (await build()).request("/audits")).text();
    expect(html).toContain("scheduled audits");
    expect(html).toContain("fill the idle");
    expect(html).toContain("why schedule audits");
    expect(html).toContain("audit jobs");
  });

  it("renders each audit job: kind / cadence / window / cli / findings + toggle", async () => {
    const html = await (await (await build()).request("/audits")).text();
    expect(html).toContain("security scan");
    expect(html).toContain("accessibility (a11y)");
    expect(html).toContain("claude · haiku-4.5");
    expect(html).toContain("chatgpt · night (00–05)");
    // findings cell links to the inbox; warn job shows "2 found".
    expect(html).toContain("2 found");
    expect(html).toContain('href="/inbox"');
    // enable/disable toggle forms.
    expect(html).toContain("/audits/audit_a11y/disable");
    expect(html).toContain("/audits/audit_mut/enable");
    // run-now action.
    expect(html).toContain("/audits/audit_sec/run");
  });

  it("renders the forge-recommended coverage panel with one-click schedule", async () => {
    const html = await (await (await build()).request("/audits")).text();
    expect(html).toContain("forge recommends");
    expect(html).toContain("performance budget");
    expect(html).toContain("license compliance");
    expect(html).toContain('data-action="schedule-rec"');
  });

  it("renders the new-audit composer that POSTs to /audits", async () => {
    const html = await (await (await build()).request("/audits")).text();
    expect(html).toContain("new scheduled audit");
    expect(html).toContain("data-composer");
    expect(html).toContain('data-action="create"');
  });

  it("composer POST creates a job and redirects back", async () => {
    const app = await build();
    const res = await app.request("/audits", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "kind=security&name=security+scan&cadence=nightly&targetWindow=night&answererCli=claude",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/audits");
  });

  it("enable + run actions POST and redirect back", async () => {
    const app = await build();
    const enable = await app.request("/audits/audit_mut/enable", {
      method: "POST",
      redirect: "manual",
    });
    expect(enable.status).toBe(302);
    expect(enable.headers.get("location")).toBe("/audits");
    const run = await app.request("/audits/audit_sec/run", { method: "POST", redirect: "manual" });
    expect(run.status).toBe(302);
  });

  it("renders an empty state when there are no jobs", async () => {
    mockOrchestrator({ jobs: [], recommended: [] });
    const html = await (await (await build()).request("/audits")).text();
    expect(html).toContain("No scheduled audits yet");
  });
});
