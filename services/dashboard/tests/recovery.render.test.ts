// P2B-0008 — rendered-HTML acceptance tests for the halted-run failure-recovery
// surface. Mirrors the run-detail render harness: build the app with a stubbed
// pool + a mocked orchestrator (global fetch) and assert the server-rendered
// HTML and the same-origin recovery-action proxies. No live orchestrator/runner.
//
// The fixture is a fixture-medium run forced to halt by an auditor-disagreement
// scenario (outcome=retry_budget_exhausted), so the real-functionality bar —
// "a halted run can be recovered via revise + replan through the dashboard" —
// is exercised end to end against fakes.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";
import type { RunDetail } from "../src/api/types.js";

const ORG = { id: "org_acme", kind: "github_org", login: "cat-cave", displayName: "Cat Cave", role: "org:admin" };
const PROJECT = {
  projectId: "project_medium",
  name: "tanren-fixture-medium",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-medium",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker"
};
const RUN_ID = "run_a347d4";
const SPEC_ID = "spec_a4f";

const RUN_DETAIL: RunDetail = {
  run: {
    runId: RUN_ID,
    specId: SPEC_ID,
    projectId: PROJECT.projectId,
    branch: "tanren/no-ssr-flash",
    trigger: "dashboard",
    status: "halted",
    outcome: "retry_budget_exhausted",
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    prUrl: null
  },
  spec: {
    specId: SPEC_ID,
    title: "no SSR theme flash",
    description: "behavior 5 — no client flash on first paint",
    behaviorIds: ["bhv_no_flash"],
    milestoneId: "m4"
  },
  tasks: [
    { taskId: "plan_1", runId: RUN_ID, kind: "plan", parentTaskId: null, title: "decompose", status: "done", outcome: "rejected_by_auditor", failureKind: "auditor_disagreement", attempt: 3, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), endedAt: new Date().toISOString() },
    { taskId: "write_1", runId: RUN_ID, kind: "write", parentTaskId: "plan_1", title: "wire no-flash guard", status: "done", outcome: "passed", failureKind: null, attempt: 0, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), endedAt: new Date(Date.now() - 8 * 60_000).toISOString() }
  ],
  recentEvents: [
    { id: 1, ts: new Date(Date.now() - 9 * 60_000).toISOString(), runId: RUN_ID, taskId: "write_1", specId: SPEC_ID, projectId: PROJECT.projectId, eventType: "workspace.git_captured", payload: { workspacePath: "/w", commits: [{ sha: "9f3a2b4", message: "wire guard" }], diffBytes: 100 }, redactedPaths: [] },
    { id: 2, ts: new Date(Date.now() - 5 * 60_000).toISOString(), runId: RUN_ID, taskId: "plan_1", specId: SPEC_ID, projectId: PROJECT.projectId, eventType: "auditor.rejected", payload: { runId: RUN_ID, auditTaskId: "audit_1", reason: "race still possible client-side", outstandingBehaviorIds: ["bhv_no_flash"], recommendedAction: "revise" }, redactedPaths: [] },
    { id: 3, ts: new Date(Date.now() - 4 * 60_000).toISOString(), runId: RUN_ID, taskId: "plan_1", specId: SPEC_ID, projectId: PROJECT.projectId, eventType: "planner.rerequested", payload: { runId: RUN_ID, plannerTaskId: "plan_1", producer: "auditor", rejectionReason: "race still possible", behaviorIdsFailed: ["bhv_no_flash"], plannerRerunCount: 3, maxPlannerRerunsPerSpec: 3 }, redactedPaths: [] }
  ],
  costs: [
    { id: 1, runId: RUN_ID, taskId: "write_1", projectId: PROJECT.projectId, cli: "codex", provider: "openai", model: "gpt-5", inputTokens: 1200, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 600, reasoningOutputTokens: 0, totalTokens: 1800, costUsd: "0.8400", billingMode: "per_token", costBasis: "provider_pricing", recordedAt: new Date().toISOString() }
  ],
  insights: [],
  forgeThread: null
};

const SPECS = [
  { specId: SPEC_ID, projectId: PROJECT.projectId, title: "no SSR theme flash", description: "", acceptanceCriteria: [], dependsOn: [], status: "active" },
  { specId: "spec_pick", projectId: PROJECT.projectId, title: "pick list ui", description: "", acceptanceCriteria: [], dependsOn: [SPEC_ID], status: "pending" },
  { specId: "spec_scan", projectId: PROJECT.projectId, title: "scan item to tote", description: "", acceptanceCriteria: [], dependsOn: [SPEC_ID], status: "pending" }
];

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let recoveryCalls: Array<{ url: string; method: string; body: string | undefined }> = [];

function mockOrchestrator(opts: { recoverable?: boolean; lastGoodCommit?: string | null; runActionOk?: boolean } = {}): void {
  const recoverable = opts.recoverable ?? true;
  const lastGoodCommit = opts.lastGoodCommit === undefined ? "9f3a2b4" : opts.lastGoodCommit;
  const runActionOk = opts.runActionOk ?? true;
  recoveryCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      const run = recoverable ? RUN_DETAIL.run : { ...RUN_DETAIL.run, status: "running", outcome: null };
      return new Response(JSON.stringify({ items: [{ ...run, specTitle: RUN_DETAIL.spec.title, costTotalUsd: "0.84", lastEventAt: null, needsReview: false }] }), { status: 200 });
    }
    if (url.endsWith(`/projects/${PROJECT.projectId}/specs`)) return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    // recovery action POST proxies
    if (url.includes("/recovery/") && method === "POST") {
      recoveryCalls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (!runActionOk) return new Response(JSON.stringify({ error: "run_not_recoverable", message: "nope" }), { status: 409 });
      if (url.endsWith("/recovery/revise")) return new Response(JSON.stringify({ ok: true, result: { action: "revise_spec", runId: RUN_ID, specId: SPEC_ID, editHref: `/projects/${PROJECT.projectId}/specs/${SPEC_ID}/edit?recoverRunId=${RUN_ID}` } }), { status: 200 });
      if (url.endsWith("/recovery/replan")) return new Response(JSON.stringify({ ok: true, result: { action: "replan_with_steering", runId: RUN_ID, specId: SPEC_ID, replanRunId: "run_replan_1", plannerTaskId: "task_p1" } }), { status: 200 });
      if (url.endsWith("/recovery/rollback")) return new Response(JSON.stringify({ ok: true, result: { action: "rollback_to_commit", runId: RUN_ID, specId: SPEC_ID, commitSha: "9f3a2b4", replanRunId: "run_rb_1" } }), { status: 200 });
      if (url.endsWith("/recovery/inspection-thread")) return new Response(JSON.stringify({ ok: true, result: { action: "open_inspection_thread", runId: RUN_ID, specId: SPEC_ID, threadId: "forge_thread_xyz" } }), { status: 200 });
    }
    // recovery context GET
    if (url.includes("/recovery") && method === "GET") {
      return new Response(JSON.stringify({ runId: RUN_ID, specId: SPEC_ID, projectId: PROJECT.projectId, status: "halted", outcome: "retry_budget_exhausted", lastGoodCommit }), { status: 200 });
    }
    // run detail
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream") && !url.includes("/recovery")) {
      const detail = recoverable ? RUN_DETAIL : { ...RUN_DETAIL, run: { ...RUN_DETAIL.run, status: "running", outcome: null } };
      return new Response(JSON.stringify(detail), { status: 200 });
    }
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("P2B-0008 halted-run list", () => {
  it("lists halted runs at /runs/halted (claiming the route from the shell placeholder)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/runs/halted")).text();
    expect(html).toContain("halted runs");
    expect(html).toContain("no SSR theme flash");
    expect(html).toContain(RUN_ID);
    // not the P2B-0004 placeholder
    expect(html).not.toContain("documented placeholder");
  });
});

describe("P2B-0008 recovery surface", () => {
  it("renders the page head with run/spec/retry/elapsed/$ framing + halted pill", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("get the");
    expect(html).toContain("engine");
    expect(html).toContain(RUN_ID);
    expect(html).toContain(SPEC_ID);
    expect(html).toContain("$0.84 spent");
    expect(html).toContain('class="pill fail"');
  });

  it("renders the four failure-context cells from the event history", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("what blocked it");
    expect(html).toContain("auditor disagrees with writer");
    expect(html).toContain("last good state");
    expect(html).toContain("9f3a2b4");
    expect(html).toContain("blocks downstream");
    expect(html).toContain("elapsed at hatch");
    expect(html).toContain("retry budget exhausted");
  });

  it("renders all four recovery cards + last-resort abandon", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("revise the spec");
    expect(html).toContain("forge recommends");
    expect(html).toContain("replan with instructions");
    expect(html).toContain("rollback the code");
    expect(html).toContain("resolve via conversation");
    expect(html).toContain("last resort");
    // forms post to the same-origin recovery proxies
    expect(html).toContain(`action="/runs/${RUN_ID}/recover/revise"`);
    expect(html).toContain(`action="/runs/${RUN_ID}/recover/replan"`);
    expect(html).toContain(`action="/runs/${RUN_ID}/recover/inspection-thread"`);
  });

  it("enables rollback with a commit + confirm checkbox when a prior commit exists", async () => {
    mockOrchestrator({ lastGoodCommit: "9f3a2b4" });
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain(`action="/runs/${RUN_ID}/recover/rollback"`);
    expect(html).toContain('name="confirmed"');
    expect(html).toContain("cannot be undone");
  });

  it("disables rollback when no prior commit exists", async () => {
    mockOrchestrator({ lastGoodCommit: null });
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("no prior commit to roll back to");
    expect(html).toContain("disabled");
    expect(html).not.toContain(`action="/runs/${RUN_ID}/recover/rollback"`);
  });

  it("renders the flat downstream-impact list (no full DAG)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("dag impact");
    expect(html).toContain("no SSR theme flash halted");
    expect(html).toContain("pick list ui");
    expect(html).toContain("scan item to tote");
  });

  it("shows 'nothing to recover' for a non-halted run", async () => {
    mockOrchestrator({ recoverable: false });
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/recover`)).text();
    expect(html).toContain("run is not halted");
  });
});

describe("P2B-0008 recovery action proxies", () => {
  it("revise → proxies to the orchestrator + renders the spec-edit link", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/revise`, { method: "POST" });
    const html = await res.text();
    expect(recoveryCalls.some((c) => c.url.endsWith("/recovery/revise"))).toBe(true);
    expect(html).toContain("spec revision routed");
    expect(html).toContain(`/specs/${SPEC_ID}/edit`);
  });

  it("replan → carries the steering note + renders the queued replan run", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/replan`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "steeringNote=split+behavior+5+into+5a+%2B+5b"
    });
    const html = await res.text();
    const call = recoveryCalls.find((c) => c.url.endsWith("/recovery/replan"));
    expect(call?.body).toContain("split behavior 5 into 5a + 5b");
    expect(html).toContain("replan queued");
    expect(html).toContain("run_replan_1");
  });

  it("replan → rejects an empty steering note without proxying", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/replan`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "steeringNote="
    });
    const html = await res.text();
    expect(recoveryCalls.some((c) => c.url.endsWith("/recovery/replan"))).toBe(false);
    expect(html).toContain("steering note is required");
  });

  it("rollback → never proxies without confirmation", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/rollback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "commitSha=9f3a2b4"
    });
    const html = await res.text();
    expect(recoveryCalls.some((c) => c.url.endsWith("/recovery/rollback"))).toBe(false);
    expect(html).toContain("not confirmed");
  });

  it("rollback → proxies with confirm=true", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/rollback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "commitSha=9f3a2b4&confirmed=true"
    });
    const html = await res.text();
    expect(recoveryCalls.some((c) => c.url.endsWith("/recovery/rollback"))).toBe(true);
    expect(html).toContain("rolled back");
  });

  it("inspection-thread → proxies + renders the thread binding", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/inspection-thread`, { method: "POST" });
    const html = await res.text();
    expect(recoveryCalls.some((c) => c.url.endsWith("/recovery/inspection-thread"))).toBe(true);
    expect(html).toContain("inspection thread opened");
    expect(html).toContain("forge_thread_xyz");
  });

  it("surfaces an orchestrator failure without faking success", async () => {
    mockOrchestrator({ runActionOk: false });
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/recover/revise`, { method: "POST" });
    const html = await res.text();
    expect(html).toContain("recovery not applied");
  });
});
