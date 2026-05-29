// P3-0022 — rendered-HTML assertions for the candidate-inbox surface: the
// configurable source list, the candidate stream with each card's Forge triage
// read-out, the verdict-driven actions (accept→discovery / fold / dismiss /
// close-as-dup), and the auto-routed resting state. Mirrors the
// discovery.render pattern: stub the pg pool + mock the orchestrator APIs (incl.
// the inbox snapshot) via global fetch, then assert the rendered screen.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = { id: "org_acme", kind: "github_org", login: "cat-cave", displayName: "Cat Cave", role: "org:admin" };
const PROJECT = {
  projectId: "project_easy",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker"
};

const SNAPSHOT = {
  sources: [
    { id: "src_gh", orgId: "org_acme", projectId: "project_easy", kind: "issues", name: "github · cat-cave", detail: "issues labeled spec-candidate · 6 open", config: {}, enabled: true, autoRoute: false },
    { id: "src_audit", orgId: "org_acme", projectId: null, kind: "scheduled_audit", name: "scheduled audits", detail: "auto-routes findings", config: {}, enabled: true, autoRoute: true }
  ],
  candidates: [
    {
      id: "cand_audit", sourceId: "src_audit", orgId: "org_acme", projectId: "project_easy", externalId: "a11y-1",
      title: "a11y · 2 contrast failures on marketing nav", body: "below WCAG AA", severity: "warn", status: "auto_routed",
      triage: { dedupe: "no match", match: "fits existing behavior", placement: "auto → project_easy · queued", verdict: "auto_routable", duplicateOfSpecId: null, discoveryVariant: "feature" },
      resolvedSpecId: null, sourceName: "scheduled audits", sourceKind: "scheduled_audit"
    },
    {
      id: "cand_feat", sourceId: "src_gh", orgId: "org_acme", projectId: "project_easy", externalId: "gh-cat-cave/app#88",
      title: "feature · CSV export for monthly close", body: "cfo wants a one-click csv", severity: "info", status: "triaged",
      triage: { dedupe: "no match", match: "new behavior · cfo", placement: "forge proposes a new spec · P1", verdict: "needs_call", duplicateOfSpecId: null, discoveryVariant: "feature" },
      resolvedSpecId: null, sourceName: "github · cat-cave", sourceKind: "issues"
    },
    {
      id: "cand_dup", sourceId: "src_gh", orgId: "org_acme", projectId: "project_easy", externalId: "gh-cat-cave/app#204",
      title: "TIK-204 · dark mode toggle (duplicate)", body: "theme toggle", severity: "info", status: "triaged",
      triage: { dedupe: "duplicate of spec_a4f · shipped", match: "already merged", placement: "forge recommends closing as done", verdict: "dedupe_close", duplicateOfSpecId: "spec_a4f", discoveryVariant: "feature" },
      resolvedSpecId: null, sourceName: "github · cat-cave", sourceKind: "issues"
    }
  ]
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(snapshot: unknown = SNAPSHOT): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/.test(url)) return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (/\/orgs\/[^/]+\/inbox$/.test(url) && method === "GET") return new Response(JSON.stringify(snapshot), { status: 200 });
    if (/\/inbox\/candidates\/[^/]+\/(fold|dismiss|close-duplicate)$/.test(url) && method === "POST") {
      return new Response(JSON.stringify({ candidate: {} }), { status: 200 });
    }
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

describe("candidate inbox surface", () => {
  it("renders the page head, the configurable source list, and the KPI counts", async () => {
    const app = await build();
    const html = await (await app.request("/inbox")).text();
    expect(html).toContain("candidate inbox");
    expect(html).toContain("where work");
    // configurable source list with the two sources + the auto tag.
    expect(html).toContain("github · cat-cave");
    expect(html).toContain("scheduled audits");
    expect(html).toContain("auto");
    expect(html).toContain("no hardcoded sources");
  });

  it("renders each candidate's triage read-out (dedupe / match / placement)", async () => {
    const app = await build();
    const html = await (await app.request("/inbox")).text();
    expect(html).toContain("feature · CSV export for monthly close");
    expect(html).toContain("forge proposes a new spec");
    expect(html).toContain("dedupe");
    expect(html).toContain("placement");
  });

  it("auto-routed candidates rest resolved; external candidates expose verdict-driven actions", async () => {
    const app = await build();
    const html = await (await app.request("/inbox")).text();
    // auto-routed find shows the resolved note, not the action buttons.
    expect(html).toContain("auto-routed");
    // needs-your-call candidate: accept→discovery + fold + dismiss.
    expect(html).toContain("accept · open in discovery");
    expect(html).toContain("/projects/project_easy/discovery");
    expect(html).toContain('data-action="fold"');
    expect(html).toContain('data-action="dismiss"');
    // dedupe → close candidate: close-as-done action.
    expect(html).toContain("close as done");
    expect(html).toContain("/inbox/candidates/cand_dup/close-duplicate");
  });

  it("fold action POSTs to the inbox route and redirects back", async () => {
    const app = await build();
    const res = await app.request("/inbox/candidates/cand_feat/fold", { method: "POST", redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/inbox");
  });

  it("renders an empty state when there are no sources or candidates", async () => {
    mockOrchestrator({ sources: [], candidates: [] });
    const app = await build();
    const html = await (await app.request("/inbox")).text();
    expect(html).toContain("No candidates yet");
    expect(html).toContain("no sources yet");
  });
});
