// P2B-0004 — rendered-HTML acceptance tests for the run-detail + review
// surfaces. Mirrors the shell render harness (shell.render.test.ts): build the
// app with a stubbed pool + a mocked orchestrator (global fetch) and assert the
// server-rendered HTML. No live orchestrator, no DB.
//
// The fixture is a fixture-medium acceptance run *including the rejection loop*
// (an auditor-rejected write subtask, then a passing retry) so the
// real-functionality bar — "a fixture-medium acceptance run is fully
// inspectable from this screen including the rejection loop" — is exercised.

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
const RUN_ID = "run_medium_001";

const RUN_DETAIL: RunDetail = {
  run: {
    runId: RUN_ID,
    specId: "spec_settings",
    projectId: PROJECT.projectId,
    branch: "tanren/spec_settings",
    trigger: "operator",
    status: "running",
    outcome: null,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endedAt: null,
    prUrl: "https://github.com/cat-cave/tanren-fixture-medium/pull/142"
  },
  spec: {
    specId: "spec_settings",
    title: "persist theme to localStorage",
    description: "wire the settings dropdown into localStorage",
    behaviorIds: ["bhv_persist", "bhv_no_ssr_mismatch"],
    milestoneId: "m4"
  },
  tasks: [
    { taskId: "plan_1", runId: RUN_ID, kind: "plan", parentTaskId: null, title: "decompose the spec", status: "done", outcome: "passed", failureKind: null, attempt: 0, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 5 * 60_000).toISOString(), endedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
    { taskId: "write_1", runId: RUN_ID, kind: "write", parentTaskId: "plan_1", title: "wire localStorage persistence", status: "done", outcome: "passed", failureKind: null, attempt: 0, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), endedAt: new Date(Date.now() - 3 * 60_000).toISOString() },
    // The rejection loop: an auditor-rejected attempt of subtask 2 ...
    { taskId: "write_2_rej", runId: RUN_ID, kind: "write", parentTaskId: "plan_1", title: "add profile-sync hook", status: "done", outcome: "rejected_by_auditor", failureKind: "auditor_disagreement", attempt: 0, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), endedAt: new Date(Date.now() - 2 * 60_000).toISOString() },
    // ... then the live retry.
    { taskId: "write_2", runId: RUN_ID, kind: "write", parentTaskId: "plan_1", title: "add profile-sync hook (retry)", status: "running", outcome: null, failureKind: null, attempt: 1, cli: "codex", model: "gpt-5", startedAt: new Date(Date.now() - 1 * 60_000).toISOString(), endedAt: null },
    { taskId: "audit_1", runId: RUN_ID, kind: "audit", parentTaskId: null, title: "audit the change", status: "queued", outcome: null, failureKind: null, attempt: 0, cli: "codex", model: "gpt-5", startedAt: null, endedAt: null }
  ],
  recentEvents: [
    { id: 1, ts: new Date().toISOString(), runId: RUN_ID, taskId: "write_2", specId: "spec_settings", projectId: PROJECT.projectId, eventType: "writer.intent", payload: { intent: "wire the profile-sync hook behind a feature flag" }, redactedPaths: [] },
    { id: 2, ts: new Date().toISOString(), runId: RUN_ID, taskId: "write_2", specId: "spec_settings", projectId: PROJECT.projectId, eventType: "tool.call", payload: { tool: "edit_file", arg: "useProfileSync.ts", output: "+24 -1" }, redactedPaths: [] },
    { id: 3, ts: new Date().toISOString(), runId: RUN_ID, taskId: "write_2", specId: "spec_settings", projectId: PROJECT.projectId, eventType: "secret.scan", payload: {}, redactedPaths: ["token"] },
    { id: 4, ts: new Date().toISOString(), runId: RUN_ID, taskId: "write_1", specId: "spec_settings", projectId: PROJECT.projectId, eventType: "writer.deferral", payload: { tag: "follow-up", title: "extract a useLocalStorage hook", detail: "duplicated localStorage access across two components" }, redactedPaths: [] }
  ],
  costs: [
    { id: 1, runId: RUN_ID, taskId: "write_1", projectId: PROJECT.projectId, cli: "codex", provider: "openai", model: "gpt-5", inputTokens: 1200, cachedInputTokens: 400, cacheCreationTokens: 0, outputTokens: 600, reasoningOutputTokens: 0, totalTokens: 1800, costUsd: "0.0240", billingMode: "per_token", costBasis: "provider_pricing", recordedAt: new Date().toISOString() },
    { id: 2, runId: RUN_ID, taskId: "write_2", projectId: PROJECT.projectId, cli: "claude", provider: "anthropic", model: "claude-sonnet", inputTokens: 800, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 300, reasoningOutputTokens: 0, totalTokens: 1100, costUsd: null, billingMode: "subscription", costBasis: "ccusage", recordedAt: new Date().toISOString() },
    { id: 3, runId: RUN_ID, taskId: "audit_1", projectId: PROJECT.projectId, cli: "ollama", provider: "self", model: "qwen-local", inputTokens: 400, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 120, reasoningOutputTokens: 0, totalTokens: 520, costUsd: "0.0000", billingMode: "self_hosted", costBasis: "unknown", recordedAt: new Date().toISOString() }
  ],
  insights: [
    { kind: "pace_anomaly", specTitle: "persist theme to localStorage" }
  ],
  forgeThread: null
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    // run list (used to resolve runId → project)
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      return new Response(JSON.stringify({ items: [{ ...RUN_DETAIL.run, specTitle: RUN_DETAIL.spec.title, costTotalUsd: "0.0240", lastEventAt: null, needsReview: false }] }), { status: 200 });
    }
    // run detail
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream")) {
      return new Response(JSON.stringify(RUN_DETAIL), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
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

describe("P2B-0004 run-detail screen", () => {
  it("renders the page head with run id, spec, and branch", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("the agent"); // "the agent's thinking" (apostrophe HTML-escaped)
    expect(html).toContain("thinking");
    expect(html).toContain(RUN_ID);
    expect(html).toContain("persist theme to localStorage");
    expect(html).toContain("tanren/spec_settings");
  });

  it("renders the unified cost bar across all real sources (no unknown-source placeholder)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("per-token");
    expect(html).toContain("window");
    expect(html).toContain("self-hosted"); // label exists even if 0
    expect(html).toContain("$0.0240"); // real per-token dollars
    expect(html).toContain("by model");
    expect(html).toContain("gpt-5");
    expect(html).toContain("claude-sonnet");
    expect(html).not.toMatch(/unknown[- ]source/i);
  });

  it("renders the trajectory spine including the rejection loop", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("trajectory");
    expect(html).toContain("write subtask 1");
    expect(html).toContain("write subtask 2"); // rejected attempt
    expect(html).toContain("write subtask 3"); // retry
    expect(html).toContain("auditor_disagreement"); // the rejection is visible
    expect(html).toContain('class="dot failed"'); // rejected dot styled as failed
  });

  it("renders the writer reasoning pane from typed events (intent, tools, redaction)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("reasoning"); // "writer's reasoning" (apostrophe HTML-escaped)
    expect(html).toContain("wire the profile-sync hook behind a feature flag"); // intent
    expect(html).toContain("edit_file"); // tool call
    expect(html).toContain("hidden by redaction"); // redactedPaths surfaced
    expect(html).toContain("ask forge"); // ask-forge CTA
  });

  it("surfaces the pace_anomaly workflow insight", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("workflow insight · pace_anomaly");
  });

  it("renders PR + CI status chips", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("pull/142");
    expect(html).toContain("run · running");
  });

  it("offers the raw-view toggle to an org admin and links the SSE island", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("view raw ↗");
    expect(html).toContain('data-island="run-stream"');
    expect(html).toContain(`/runs/${RUN_ID}/stream`);
  });

  it("delegates /runs/halted to P2B-0008's halted-run list (not the run-detail page)", async () => {
    // The `:runId` handler must NOT treat the literal `halted` as a run id —
    // it delegates via next() so P2B-0008's halted-run list claims the route.
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/runs/halted")).text();
    expect(html).toContain("halted runs");
    // not the run-detail body, not run-not-found
    expect(html).not.toContain("run not visible");
    expect(html).not.toContain("the agent");
  });

  it("renders run-not-found for an unknown run", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request("/runs/run_does_not_exist");
    const html = await res.text();
    expect(html).toContain("run not visible");
  });
});

describe("P2B-0004 review handoff", () => {
  it("renders the behavior checklist, deferral, and readiness gate", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain("review with forge");
    expect(html).toContain("pr #142");
    // behaviors from the spec
    expect(html).toContain("bhv_persist");
    expect(html).toContain("bhv_no_ssr_mismatch");
    expect(html).toContain('data-island="review"');
    // writer deferral pulled from the events
    expect(html).toContain("extract a useLocalStorage hook");
    expect(html).toContain("handle now · replan + subtasks");
    // readiness gate pills
    expect(html).toContain("you-verified");
    expect(html).toContain("deferred ·");
    // request changes always available
    expect(html).toContain("request changes");
  });

  it("renders the not_configured merge branch (no merge integration → configure link)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain("repo has no merge integration");
    expect(html).toContain("configure ↗");
  });

  it("request-changes POST records the loop-back to the planner", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request(`/runs/${RUN_ID}/review/request-changes`, { method: "POST" });
    const html = await res.text();
    expect(html).toContain("looped back to the planner");
    expect(html).toContain("P2A-0012");
  });
});

// ---------------------------------------------------------------------------
// P3-0025 — live preview-deploy pane in the review surface.
// ---------------------------------------------------------------------------

/**
 * Mock that ALSO answers the project-detail read (`getProject`) so the review
 * route can derive a preview URL from `config.previewUrlPattern`. When
 * `previewUrlPattern` is undefined the project parses with no preview field.
 */
function mockOrchestratorWithProject(previewUrlPattern?: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    // project detail (getProject) — carries the merged config incl. preview pattern
    if (url.endsWith(`/orgs/${ORG.id}/projects/${PROJECT.projectId}`)) {
      return new Response(
        JSON.stringify({
          ...PROJECT,
          defaultBranch: "main",
          runnerImage: null,
          allocator: "local_docker",
          config: {
            version: 1,
            routing: {},
            escapeHatches: {},
            mergeIntegration: "not_configured",
            ...(previewUrlPattern !== undefined ? { previewUrlPattern } : {})
          }
        }),
        { status: 200 }
      );
    }
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      return new Response(JSON.stringify({ items: [{ ...RUN_DETAIL.run, specTitle: RUN_DETAIL.spec.title, costTotalUsd: "0.0240", lastEventAt: null, needsReview: false }] }), { status: 200 });
    }
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream")) {
      return new Response(JSON.stringify(RUN_DETAIL), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("P3-0025 live preview-deploy pane", () => {
  it("renders a sandboxed iframe at the per-PR preview URL when a pattern is configured", async () => {
    mockOrchestratorWithProject("https://pr-{pr}.preview.fly.dev");
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    // PR #142 from the run's prUrl filled into the pattern
    expect(html).toContain("https://pr-142.preview.fly.dev");
    expect(html).toContain('class="preview-iframe"');
    // sandboxed for safety — no allow-same-origin so it can't reach the session
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups"');
    expect(html).not.toContain("allow-same-origin");
    // device-width tabs present with their widths
    expect(html).toContain('data-review="device-tabs"');
    expect(html).toContain('data-width="768px"');
    expect(html).toContain('data-width="375px"');
    // open-in-new-tab link to the live preview
    expect(html).toContain("open ↗");
  });

  it("renders the graceful empty state when no preview URL is configured", async () => {
    mockOrchestratorWithProject(); // project has no previewUrlPattern
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain("no preview url configured");
    expect(html).toContain("no live preview for this run");
    expect(html).toContain("previewUrlPattern");
    // no iframe in the empty state
    expect(html).not.toContain('class="preview-iframe"');
    // device tabs still render (they re-width the placeholder)
    expect(html).toContain('data-review="device-tabs"');
  });
});
