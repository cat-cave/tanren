// rendered-HTML assertions for the greenfield onboarding surface:
// the 3-step shell, the vision-interview chat + live capture panel (round
// accumulates captures via a MOCKED orchestrator interview route), the derived
// spec-DAG step (rendered via the DagCanvas over the live derived
// graph), and the arrival card. Mirrors the discovery.render pattern: stub the
// pg pool + mock the orchestrator APIs via global fetch, then assert the HTML.

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture/behavior fixtures.

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
  projectId: "project_derived",
  name: "supply-chain-os",
  repoUrl: "https://github.com/supply-chain-os",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

const CAPTURE_AFTER_ROUND = {
  identity: { slug: "supply-chain-os", pitch: "supply chain ops.", repoHint: "" },
  personas: [{ name: "line worker", description: "barcode + bin moves", surface: "handheld" }],
  behaviors: [{ persona: "line worker", title: "clock in with badge", given: "", when: "", then: "" }],
  interfaces: [],
  designContract: null,
  architecture: [],
  rulesets: [],
};

const ROUND_RESULT = {
  round: 3,
  totalRounds: 14,
  say: "Now I want to nail the behaviors for the line worker.",
  suggestions: [{ label: "tote has its own barcode", value: "tote has its own barcode" }],
  capture: CAPTURE_AFTER_ROUND,
  complete: false,
};

const DERIVE_RESULT = {
  projectId: "project_derived",
  projectName: "supply-chain-os",
  specIds: ["spec_1", "spec_2", "spec_3", "spec_4"],
  personaIds: ["persona_1"],
  behaviorIds: ["behavior_1"],
  milestoneIds: ["m1", "m2"],
};

const SPECS = [
  {
    specId: "spec_1",
    projectId: "project_derived",
    title: "monorepo scaffold",
    description: "x",
    acceptanceCriteria: ["a"],
    dependsOn: [],
    status: "open",
  },
  {
    specId: "spec_2",
    projectId: "project_derived",
    title: "handheld · schema + scaffold",
    description: "x",
    acceptanceCriteria: ["a"],
    dependsOn: ["spec_1"],
    status: "open",
  },
  {
    specId: "spec_3",
    projectId: "project_derived",
    title: "clock in with badge",
    description: "x",
    acceptanceCriteria: ["a"],
    dependsOn: ["spec_1", "spec_2"],
    status: "open",
  },
];
const MILESTONES = [
  { id: "m1", label: "M1", name: "scaffold", status: "planned" },
  { id: "m2", label: "M2", name: "handheld", status: "planned" },
];

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

// Captures the last derive request body so tests can assert the payload the UI
// now sends (owner/autonomy/deploy) — the #1233 fix.
let lastDeriveBody: Record<string, unknown> | undefined;

function mockOrchestrator(): void {
  lastDeriveBody = undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/integrations(\?|$)/u.test(url))
      return new Response(JSON.stringify({ integrations: [] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (url.endsWith("/onboarding/interview/round") && method === "POST")
      return new Response(JSON.stringify(ROUND_RESULT), { status: 200 });
    if (url.endsWith("/onboarding/interview/derive") && method === "POST") {
      lastDeriveBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(DERIVE_RESULT), { status: 201 });
    }
    if (url.endsWith("/specs") && method === "GET")
      return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    if (url.endsWith("/milestones") && method === "GET")
      return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
    if (url.endsWith("/runs") && method === "GET") return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.endsWith("/personas") && method === "GET")
      return new Response(JSON.stringify({ personas: [] }), { status: 200 });
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

describe("greenfield · interview (step 1)", () => {
  it("renders the journey strip, the interview chat + the live capture panel", async () => {
    const app = await build();
    const html = await (await app.request("/onboarding/new")).text();
    expect(html).toContain('data-screen="onboarding-new"');
    expect(html).toContain("data-greenfield-journey");
    expect(html).toContain("data-interview-chat");
    expect(html).toContain("data-capture-panel");
    expect(html).toContain("forge asks");
    // the round meta + the forge question from the mocked round.
    expect(html).toContain("round 3 of ~14");
    expect(html).toContain("nail the behaviors");
    // pure-HTML interview posts need the server-rendered csrf field.
    expect(html).toContain('name="csrf"');
    expect(html).toContain('value="c"');
  });

  it("a round POST accumulates the capture into the live panel + offers suggestions", async () => {
    const app = await build();
    const res = await app.request("/onboarding/new?step=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        phase: "round",
        round: "3",
        answer: "they clock in with a badge",
        capture: JSON.stringify({}),
      }),
    });
    const html = await res.text();
    // the operator's answer renders as a user turn.
    expect(html).toContain("they clock in with a badge");
    // the capture panel now shows the accumulated identity + persona + behavior.
    expect(html).toContain("supply-chain-os");
    expect(html).toContain("line worker");
    expect(html).toContain("clock in with badge");
    // the inline suggestion from the round result.
    expect(html).toContain("data-interview-suggestions");
    expect(html).toContain("tote has its own barcode");
  });
});

describe("greenfield · derive → spec dag (step 2)", () => {
  it("derives the graph and renders the LIVE derived DAG via the P3-0013 canvas", async () => {
    const app = await build();
    const capture = JSON.stringify({
      identity: { slug: "supply-chain-os", pitch: "p", repoHint: "" },
      personas: [{ name: "line worker", description: "d", surface: "handheld" }],
      behaviors: [{ persona: "line worker", title: "clock in with badge", given: "", when: "", then: "" }],
      interfaces: [{ name: "handheld", note: "" }],
      designContract: {
        domain: "saas-web",
        identity: "an industrial, dense ops console",
        intent: "a calm, scannable control surface",
        principles: [],
        constraints: [],
        personas: ["line worker"],
        behaviors: ["line worker::clock in with badge"],
        dimensions: [],
      },
      architecture: [],
      rulesets: ["main protected"],
    });
    const res = await app.request("/onboarding/new?step=2", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phase: "advance", capture, owner: "cat-cave", autonomy: "auto" }),
    });
    const html = await res.text();
    expect(html).toContain("data-derived-dag");
    expect(html).toContain("the engine");
    expect(html).toContain("derived from interview");
    // the DAG canvas rendered the derived specs (island).
    expect(html).toContain("monorepo scaffold");
    expect(html).toContain("clock in with badge");
    // advance form carries the derived projectId forward to arrival.
    expect(html).toContain('value="project_derived"');
    // #1233: the derive now sends the REQUIRED owner + the autonomy mode.
    expect(lastDeriveBody?.owner).toBe("cat-cave");
    expect(lastDeriveBody?.autonomy).toBe("auto");
  });

  it("#1233: omitting owner surfaces a field-level validation error, never a 400", async () => {
    const app = await build();
    const capture = JSON.stringify({ identity: { slug: "x", pitch: "p", repoHint: "" } });
    const res = await app.request("/onboarding/new?step=2", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      // no `owner` field — the pre-#1233 payload.
      body: new URLSearchParams({ phase: "advance", capture }),
    });
    // The UI renders a normal 200 with an inline error, not a raw 400 passthrough.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="derive-owner-error"');
    expect(html).toMatch(/github owner/iu);
    // Crucially, derive was NOT called (no doomed request → no 400).
    expect(lastDeriveBody).toBeUndefined();
    // Still shows the derive form (owner input) so the operator can correct + retry.
    expect(html).toContain('data-testid="derive-owner"');
    expect(html).not.toContain("data-derived-dag");
  });

  it("#1233: a completed interview offers linked deploy providers on the derive form", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      if (/\/orgs\/[^/]+\/integrations(\?|$)/u.test(url))
        return new Response(
          JSON.stringify({
            integrations: [
              {
                connectionId: "conn_1",
                grantId: "grant_1",
                orgId: ORG.id,
                providerKind: "deploy.flyio",
                providerPrincipalId: "pp_1",
                principalKind: "user",
                displayName: "fly-acme",
                health: "healthy",
                connectionStatus: "connected",
                providerScopes: [],
                selectedForProject: false,
              },
            ],
          }),
          { status: 200 },
        );
      if (/\/orgs\/[^/]+\/projects$/u.test(url))
        return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
      if (url.endsWith("/onboarding/interview/round") && method === "POST")
        return new Response(JSON.stringify({ ...ROUND_RESULT, complete: true }), { status: 200 });
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const res = await app.request("/onboarding/new?step=1", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phase: "round", round: "14", answer: "done", capture: JSON.stringify({}) }),
    });
    const html = await res.text();
    // owner prefilled to the org login + the linked fly.io deploy grant offered.
    expect(html).toContain('data-testid="derive-owner"');
    expect(html).toContain('value="cat-cave"');
    expect(html).toContain('data-testid="derive-deploy"');
    expect(html).toContain("deploy.flyio · fly-acme");
    expect(html).toContain("deploy.flyio::conn_1::grant_1");
  });

  it("renders DAG unavailable separately from an empty derived graph", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
          status: 200,
        });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      if (/\/orgs\/[^/]+\/projects$/u.test(url))
        return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ error: "orchestrator_unavailable" }), { status: 503 });
      if (url.endsWith("/milestones") && method === "GET")
        return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
      if (url.endsWith("/runs") && method === "GET")
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith("/personas") && method === "GET")
        return new Response(JSON.stringify({ personas: [] }), { status: 200 });
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const html = await (await app.request("/onboarding/new?step=2&projectId=project_derived")).text();
    expect(html).toContain("data-derived-dag-unavailable");
    expect(html).toMatch(/this is not an empty project/iu);
    expect(html).not.toContain("no specs derived yet");
  });
});

describe("greenfield · arrival (step 3)", () => {
  it("renders the sources / audits / dora panels + the arrival card linking into the dag", async () => {
    const app = await build();
    const res = await app.request("/onboarding/new?step=3", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phase: "advance", projectId: "project_derived" }),
    });
    const html = await res.text();
    expect(html).toContain("data-arrival-sources");
    expect(html).toContain("data-arrival-audits");
    expect(html).toContain("data-arrival-dora");
    expect(html).toContain("data-arrival-card");
    expect(html).toContain("your smithy is ready");
    expect(html).toContain("/projects/project_derived?mode=dag");
    expect(html).toContain("sentry errors");
    expect(html).not.toContain("oauth + workspace pick");
    expect(html).not.toContain("api token + project key");
    expect(html).not.toContain("any json · tanren classifies");
  });

  it("renders arrival unavailable instead of fake zero metrics when the DAG read fails", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/auth/me"))
        return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
          status: 200,
        });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
      if (/\/orgs\/[^/]+\/projects$/u.test(url))
        return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
      if (url.endsWith("/specs") && method === "GET")
        return new Response(JSON.stringify({ error: "orchestrator_unavailable" }), { status: 503 });
      if (url.endsWith("/milestones") && method === "GET")
        return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
      if (url.endsWith("/runs") && method === "GET")
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.endsWith("/personas") && method === "GET")
        return new Response(JSON.stringify({ personas: [] }), { status: 200 });
      if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const res = await app.request("/onboarding/new?step=3", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phase: "advance", projectId: "project_derived" }),
    });
    const html = await res.text();
    expect(html).toContain("graph read");
    expect(html).toContain("unavailable");
    expect(html).toMatch(/this is not an empty project/iu);
    expect(html).not.toContain("0 specs");
    expect(html).not.toContain("/projects/project_derived?mode=dag");
  });

  it("GET /onboarding/new?step=2&projectId=… re-renders the derived dag (resume)", async () => {
    const app = await build();
    const html = await (await app.request("/onboarding/new?step=2&projectId=project_derived")).text();
    expect(html).toContain("data-derived-dag");
    expect(html).toContain("monorepo scaffold");
  });
});
