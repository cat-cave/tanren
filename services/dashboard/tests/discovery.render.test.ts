// P3-0014 — rendered-HTML assertions for the spec-discovery surface: the
// insight form + provenance card, the variant tabs, the Forge classification
// thread + proposed-spec cards, the three DAG-placement options (one
// recommended), and the accept flow. Mirrors the projectDag.render pattern:
// stub the pg pool + mock the orchestrator APIs (incl. the discovery routes)
// via global fetch, then assert the rendered screens.

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

const CLASSIFY_RESULT = {
  variant: "feature",
  summary: "one spec covers the csv export gap.",
  proposals: [
    {
      proposalId: "p1",
      title: "add csv export to the stats page",
      description: "button + GET endpoint + bdd test",
      acceptanceCriteria: ["exports csv"],
      dependsOn: ["s_done"],
      priority: "P1",
      estLabel: "2h · $0.45",
    },
  ],
  placements: [
    {
      kind: "slot_after",
      label: "slot in after current p1 work",
      eta: "ready ≈ 2 weeks",
      sideEffects: "no other timelines move",
      priority: "P2",
      recommended: false,
      risk: false,
    },
    {
      kind: "jump_backlog",
      label: "jump the p1 backlog",
      eta: "ready ≈ 3 days",
      sideEffects: "next milestone slips ~2 days",
      priority: "P1",
      recommended: true,
      risk: false,
    },
    {
      kind: "interrupt",
      label: "interrupt now",
      eta: "ready ≈ 4 hours",
      sideEffects: "pauses current p0 — not recommended",
      priority: "P0",
      recommended: false,
      risk: true,
    },
  ],
  deltas: [
    {
      title: "personas",
      kind: "impact",
      count: "1 impacted",
      deltas: ["sales manager · gains 1 behavior"],
    },
    { title: "specs", kind: "add", count: "1 proposed", deltas: ["add csv export · P1 · 2h"] },
  ],
  readSummary: "grounded on 1 existing spec(s)",
};

const ACCEPT_RESULT = {
  accepted: [
    {
      proposalId: "p1",
      spec: {
        specId: "spec_new1",
        projectId: "project_easy",
        title: "add csv export to the stats page",
        status: "pending",
      },
    },
  ],
};

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
    if (/\/orgs\/[^/]+\/projects$/.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (url.endsWith("/projects/project_easy") && method === "GET")
      return new Response(JSON.stringify(PROJECT), { status: 200 });
    if (url.endsWith("/discovery/classify") && method === "POST")
      return new Response(JSON.stringify(CLASSIFY_RESULT), { status: 200 });
    if (url.endsWith("/discovery/accept") && method === "POST")
      return new Response(JSON.stringify(ACCEPT_RESULT), { status: 201 });
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

describe("discovery entry + insight form", () => {
  it("/discovery redirects to the first project's discovery surface", async () => {
    const app = await build();
    const res = await app.request("/discovery", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects/project_easy/discovery");
  });

  it("renders the insight provenance card + variant tabs + classify form (feature default)", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/discovery")).text();
    expect(html).toContain('data-discovery="insight"');
    // provenance: source + who + when from the feature seed.
    expect(html).toContain("hubspot · acme co");
    expect(html).toContain("dani · ae");
    // variant tabs (feature/bug/strategic) + the classify form.
    expect(html).toContain('data-discovery="variant-tabs"');
    expect(html).toContain("/projects/project_easy/discovery?variant=bug");
    expect(html).toContain('data-discovery="classify-form"');
    expect(html).toContain("classify with forge");
  });

  it("honours the ?variant query (bug seed + triage eyebrow)", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/discovery?variant=bug")).text();
    expect(html).toContain("triage");
    expect(html).toContain("github · #142");
  });
});

describe("discovery classification (POST)", () => {
  it("renders the classification thread, proposed-spec card, and three placement options with the recommended pick", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/discovery", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ variant: "feature", body: "acme wants csv export" }),
    });
    const html = await res.text();
    // classification panel is the discovery island.
    expect(html).toContain('data-island="discovery"');
    // the summary + proposed spec.
    expect(html).toContain("one spec covers the csv export gap");
    expect(html).toContain('data-discovery="proposal"');
    expect(html).toContain("add csv export to the stats page");
    // the three placement options, with the recommended one marked.
    expect(html).toContain('data-placement-kind="slot_after"');
    expect(html).toContain('data-placement-kind="jump_backlog"');
    expect(html).toContain('data-placement-kind="interrupt"');
    expect(html).toContain("recommended");
    // deltas panel + accept form carrying the payload (apostrophe is escaped).
    expect(html).toContain("what&#39;s changing");
    expect(html).toContain('data-discovery="accept-form"');
    expect(html).toContain('name="proposals"');
    // default chosen placement = the recommended one.
    expect(html).toContain('data-discovery="placement-kind"');
  });
});

describe("discovery accept (POST)", () => {
  it("creates the specs and renders the success banner linking into the DAG", async () => {
    const app = await build();
    const insight = JSON.stringify({
      variant: "feature",
      source: "hubspot · acme co",
      sourceLabel: "sales call note",
      who: "dani · ae",
      when: "2h ago",
      glyph: "⌥",
      body: "csv export",
    });
    const proposals = JSON.stringify(CLASSIFY_RESULT.proposals);
    const res = await app.request("/projects/project_easy/discovery/accept", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        variant: "feature",
        insight,
        proposals,
        placementKind: "jump_backlog",
        placementLabel: "jump the p1 backlog",
      }),
    });
    const html = await res.text();
    expect(html).toContain("added");
    expect(html).toContain("jump the p1 backlog");
    expect(html).toContain("/projects/project_easy?mode=dag");
  });

  it("re-renders with an error when the payload is unreadable", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/discovery/accept", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        variant: "feature",
        insight: "",
        proposals: "",
        placementKind: "slot_after",
        placementLabel: "",
      }),
    });
    const html = await res.text();
    expect(html).toContain("could not read the accepted proposals");
  });
});
