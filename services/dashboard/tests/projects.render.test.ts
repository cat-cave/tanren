// P2B-0003 verification harness — `app.request`-based rendered-HTML + POST
// behavior assertions for the chat-primary project view, spec creation, and
// routing & limits settings. Mirrors the shell test pattern
// (tests/shell.render.test.ts): stub the pg pool + mock the orchestrator
// product APIs via global fetch, then assert the rendered screens.
//
// Coverage maps to the three acceptance-criteria checklists:
//   - project-view-chat-primary.md: page head, KPI strip, narration pulse,
//     attention queue, subopt callouts (supported kinds), velocity, activity, dag.
//   - project-and-spec.md: spec list, spec creation form (schema-bound, no JSON
//     editor), create POST → P2A-0013.
//   - routing-and-limits.md: 6-role chains, vault panel, escape hatches,
//     audit-gate off caption, add/reorder/remove + save flows.

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

const RUNS = [
  {
    runId: "run_live",
    specId: "spec_a",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "running",
    outcome: null,
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: null,
    prUrl: null,
    specTitle: "supplier scorecard",
    costTotalUsd: "12.5",
    lastEventAt: "2026-05-28T10:05:00.000Z",
    needsReview: false
  },
  {
    runId: "run_review",
    specId: "spec_b",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "phase2_easy_complete",
    startedAt: "2026-05-28T09:00:00.000Z",
    endedAt: "2026-05-28T09:30:00.000Z",
    prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/142",
    specTitle: "edi mapping ui",
    costTotalUsd: "30.0",
    lastEventAt: "2026-05-28T09:30:00.000Z",
    needsReview: true
  }
];

const INSIGHTS = [
  {
    id: "ins_1",
    kind: "retry_hotspot",
    projectId: "project_easy",
    severity: "warn",
    title: "writer retries on supplier-scorecard class",
    body: "4 retries in 7 days on codex/gpt-5.5 for this spec class.",
    payload: { kind: "retry_hotspot", specId: "spec_a" },
    actions: [
      { label: "switch writer · this spec class", toolCall: { tool: "tanren.create_spec", args: {} } }
    ],
    computedAt: "2026-05-28T08:00:00.000Z",
    acknowledgedAt: null
  },
  {
    // P3-0020 review_stall — now a supported kind that MUST render.
    id: "ins_2",
    kind: "review_stall",
    projectId: "project_easy",
    severity: "warn",
    title: "review stall on auth PR",
    body: "PR #42 awaiting review for 3d with no approval or merge.",
    payload: { kind: "review_stall", specId: "spec_a", prNumber: 42 },
    actions: [],
    computedAt: "2026-05-28T08:00:00.000Z",
    acknowledgedAt: null
  }
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
    status: "in_flight"
  }
];

const FEED = [
  {
    id: 10,
    ts: "2026-05-28T10:05:00.000Z",
    runId: "run_live",
    taskId: "task_1",
    specId: "spec_a",
    projectId: "project_easy",
    eventType: "task.write.started",
    redactedPaths: []
  }
];

const SPECS = [
  {
    specId: "spec_a",
    projectId: "project_easy",
    title: "supplier scorecard",
    description: "export a supplier scorecard",
    acceptanceCriteria: ["renders a table", "exports csv"],
    dependsOn: [],
    status: "in_flight"
  }
];

const PERSONAS = [{ id: "persona_1", name: "buyer", description: "" }];
const BEHAVIORS = [{ id: "beh_1", personaId: "persona_1", title: "can export scorecard", description: null }];

const PROJECT_DETAIL = {
  ...PROJECT,
  config: {
    version: 1,
    routing: {
      plan: { chain: [{ cli: "codex", model: "gpt-5.5", authRef: "vault://dev/codex/chatgpt", healthHint: "ok" }] },
      write: { chain: [] },
      check: { chain: [] },
      audit: { chain: [] },
      demo: { chain: [] },
      forge: { chain: [] }
    },
    escapeHatches: { maxWriterIterPerSubtask: 5, maxPlannerRerunsPerSpec: 3, maxRetriesPerTransientFailure: 3 }
  }
};

const patchCalls: Array<{ url: string; body: unknown }> = [];
const toolCalls: Array<{ url: string; body: unknown }> = [];
const specCreateCalls: Array<{ url: string; body: unknown }> = [];

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (/\/orgs\/[^/]+\/projects$/.test(url)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    if (url.endsWith("/projects/project_easy") && method === "GET") {
      return new Response(JSON.stringify(PROJECT_DETAIL), { status: 200 });
    }
    if (/\/orgs\/[^/]+\/credentials$/.test(url) && method === "GET") {
      return new Response(
        JSON.stringify({
          credentials: [
            { ref: "credential/codex/org/o/c", kind: "codex_chatgpt_auth", scope: "org", ownerId: "o", createdAt: "2026-05-01" },
            { ref: "credential/github/org/o/g", kind: "github_token", scope: "org", ownerId: "o", createdAt: "2026-05-01" }
          ]
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/projects/project_easy") && method === "PATCH") {
      patchCalls.push({ url, body });
      return new Response(JSON.stringify({ projectId: "project_easy", config: body.config }), { status: 200 });
    }
    if (url.includes("/runs")) {
      return new Response(JSON.stringify({ items: RUNS }), { status: 200 });
    }
    if (url.includes("/insights")) {
      return new Response(JSON.stringify({ insights: INSIGHTS }), { status: 200 });
    }
    if (url.includes("/milestones")) {
      return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
    }
    if (url.includes("/feed")) {
      return new Response(JSON.stringify({ items: FEED }), { status: 200 });
    }
    if (url.endsWith("/specs") && method === "GET") {
      return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    }
    if (url.endsWith("/specs") && method === "POST") {
      specCreateCalls.push({ url, body });
      return new Response(JSON.stringify({ specId: "spec_new", ...body }), { status: 201 });
    }
    if (url.includes("/personas")) {
      return new Response(JSON.stringify({ personas: PERSONAS }), { status: 200 });
    }
    if (url.includes("/behaviors")) {
      return new Response(JSON.stringify({ behaviors: BEHAVIORS }), { status: 200 });
    }
    if (url.includes("/forge/threads") && url.endsWith("/threads")) {
      return new Response(JSON.stringify({ id: "thread_1" }), { status: 201 });
    }
    if (url.includes("/generate-project-view")) {
      return new Response(
        JSON.stringify({ render: { body: "tanren-fixture-easy: 1 run in flight, 1 PR review-ready; $42 spent this week.", attentionItems: [], prompts: ["What changed in the latest PR?"] } }),
        { status: 201 }
      );
    }
    if (url.endsWith("/forge/tools")) {
      toolCalls.push({ url, body });
      return new Response(JSON.stringify({ tool: body.tool, result: {} }), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  patchCalls.length = 0;
  toolCalls.length = 0;
  specCreateCalls.length = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("project view (chat-primary)", () => {
  it("renders the page head, live indicator, and discover-spec CTA", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("what needs");
    expect(html).toContain("your attention");
    expect(html).toContain("forge live");
    expect(html).toContain("/projects/project_easy/specs/new");
  });

  it("renders KPI numbers wired to real run/cost data", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("in-flight runs");
    expect(html).toContain("needs you");
    expect(html).toContain("week spend");
    // one running run, one needs-review + one insight = 2 needs-you, $42.50 spend.
    expect(html).toContain("$42.5");
  });

  it("renders the Forge narration pulse from the generated turn", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("project pulse");
    expect(html).toContain("1 PR review-ready");
  });

  it("renders the attention queue with a review handoff routing to run detail", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("things need you");
    expect(html).toContain("review-ready");
    expect(html).toContain("/projects/project_easy/runs/run_review");
  });

  it("renders subopt callouts including the P3-0020 review_stall kind", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("retry hotspot");
    expect(html).toContain("writer retries on supplier-scorecard class");
    // P3-0020 review_stall now renders (kind label is underscore-stripped).
    expect(html).toContain("review stall on auth PR");
    // callout action posts the carried tool call.
    expect(html).toContain('action="/projects/project_easy/insights/act"');
    expect(html).toContain('value="tanren.create_spec"');
  });

  it("renders the velocity card with milestone ETA and the DAG snapshot", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("velocity");
    // milestone ETA renders the target date (exact day is timezone-local).
    expect(html).toMatch(/Jun 1[78]/);
    expect(html).toContain("dag · live");
    expect(html).toContain("dag-primary mode");
  });

  it("renders the activity feed from the event stream", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy")).text();
    expect(html).toContain("activity");
    expect(html).toContain("task write started");
  });

  it("invokes the carried Forge tool when a subopt action is submitted", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/insights/act", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", tool: "tanren.acknowledge_insight", args: '{"insightId":"ins_1"}' })
    });
    expect(res.status).toBe(302);
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0].body as { tool: string }).tool).toBe("tanren.acknowledge_insight");
  });
});

describe("spec creation + list", () => {
  it("renders a schema-bound spec form with milestone, behaviors, and locked repo — no JSON editor", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs/new")).text();
    expect(html).toContain('name="title"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="acceptanceCriteria"');
    expect(html).toContain('name="milestoneId"');
    expect(html).toContain("M7 · perf");
    expect(html).toContain('name="behaviorIds"');
    expect(html).toContain("can export scorecard");
    // repo locked to the project repo.
    expect(html).toContain("https://github.com/cat-cave/tanren-fixture-easy");
    // no free-text JSON editor.
    expect(html).not.toMatch(/JSON\s*editor/i);
  });

  it("creates a spec via P2A-0013 and redirects to the spec list", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["title", "new spec"],
        ["description", "does a thing"],
        ["acceptanceCriteria", "criterion one"],
        ["milestoneId", "m_7"]
      ])
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects/project_easy/specs");
    expect(specCreateCalls).toHaveLength(1);
    const body = specCreateCalls[0].body as { title: string; acceptanceCriteria: string[] };
    expect(body.title).toBe("new spec");
    expect(body.acceptanceCriteria).toEqual(["criterion one"]);
  });

  it("re-renders the form with an error when required fields are missing", async () => {
    const app = await build();
    const res = await app.request("/projects/project_easy/specs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "", description: "", acceptanceCriteria: "" })
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("required");
    expect(specCreateCalls).toHaveLength(0);
  });

  it("lists specs with a link to the most-recent run", async () => {
    const app = await build();
    const html = await (await app.request("/projects/project_easy/specs")).text();
    expect(html).toContain("supplier scorecard");
    expect(html).toContain("/projects/project_easy/runs/run_live");
  });
});

describe("routing & limits settings", () => {
  it("renders all six role rows generated from the P2A-0006 schema", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    for (const role of ["plan", "write", "check", "audit", "demo", "forge"]) {
      expect(html).toContain(`▸ ${role}`);
    }
    // the configured Codex plan entry renders as preferred.
    expect(html).toContain("preferred");
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("vault://dev/codex/chatgpt");
  });

  it("renders the vault panel, escape hatches, and the audit-gate-OFF caption", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect(html).toContain("per-cred policy");
    expect(html).toContain("escape hatches");
    expect(html).toContain("max writer iter per subtask");
    expect(html).toContain("edits land in the dashboard");
    expect(html).not.toContain("review before merge");
  });

  it("handles a 1-entry chain (add fallback control present for every role)", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect((html.match(/\+ add fallback/g) ?? []).length).toBe(6);
  });

  it("adds a fallback entry and PATCHes the full config back", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/add", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", role: "write", cli: "codex", model: "gpt-5.5", authRef: "vault://dev/codex/chatgpt" })
    });
    expect(res.status).toBe(302);
    expect(patchCalls).toHaveLength(1);
    const body = patchCalls[0].body as { config: { routing: Record<string, { chain: unknown[] }> } };
    expect(body.config.routing.write.chain).toHaveLength(1);
  });

  it("removes a chain entry", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/remove", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", role: "plan", index: "0" })
    });
    expect(res.status).toBe(302);
    const body = patchCalls[0].body as { config: { routing: Record<string, { chain: unknown[] }> } };
    expect(body.config.routing.plan.chain).toHaveLength(0);
  });

  it("saves escape hatches with changed retry budgets", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/hatches", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", maxWriterIterPerSubtask: "8" })
    });
    expect(res.status).toBe(302);
    const body = patchCalls[0].body as { config: { escapeHatches: { maxWriterIterPerSubtask: number } } };
    expect(body.config.escapeHatches.maxWriterIterPerSubtask).toBe(8);
  });

  it("renders the credentials binding panel with org refs in both dropdowns", async () => {
    const app = await build();
    const html = await (await app.request("/settings/routing/project_easy")).text();
    expect(html).toContain("codex + github binding");
    expect(html).toContain("credential/codex/org/o/c");
    expect(html).toContain("credential/github/org/o/g");
    expect(html).toContain("inherit org default");
  });

  it("binds selected credential refs and PATCHes them into project config", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        orgId: "org_acme",
        codexCredentialRef: "credential/codex/org/o/c",
        githubCredentialRef: "credential/github/org/o/g"
      })
    });
    expect(res.status).toBe(302);
    expect((patchCalls[0].body as { config: { credentials: unknown } }).config.credentials).toEqual({
      codexCredentialRef: "credential/codex/org/o/c",
      githubCredentialRef: "credential/github/org/o/g"
    });
  });

  it("clears the binding when both selections are empty (inherit org default)", async () => {
    const app = await build();
    const res = await app.request("/settings/routing/project_easy/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ orgId: "org_acme", codexCredentialRef: "", githubCredentialRef: "" })
    });
    expect(res.status).toBe(302);
    expect((patchCalls[0].body as { config: { credentials?: unknown } }).config.credentials).toBeUndefined();
  });

  it("redirects /settings/routing to the active project's routing page", async () => {
    const app = await build();
    const res = await app.request("/settings/routing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/routing/project_easy");
  });
});
