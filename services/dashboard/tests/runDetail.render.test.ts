// rendered-HTML acceptance tests for the run-detail + review
// surfaces. Mirrors the shell render harness (shell.render.test.ts): build the
// app with a stubbed pool + a mocked orchestrator (global fetch) and assert the
// server-rendered HTML. No live orchestrator, no DB.
//
// The fixture is a fixture-medium acceptance run *including the rejection loop*
// (an auditor-rejected write subtask, then a passing retry) so the
// real-functionality bar — "a fixture-medium acceptance run is fully
// inspectable from this screen including the rejection loop" — is exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  build,
  mockOrchestrator,
  mockOrchestratorWithProject,
  ORG,
  PROJECT,
  RUN_DETAIL,
  RUN_ID,
} from "./runDetail.render.fixtures.js";
import type { RunEventRow } from "../src/api/types.js";

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P2B-0004 run-detail screen", () => {
  it("renders the page head with run id, spec, and branch", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    // "the agent's thinking" (apostrophe HTML-escaped)
    expect(html).toContain("the agent");
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
    // label exists even if 0
    expect(html).toContain("self-hosted");
    // real per-token dollars
    expect(html).toContain("$0.0240");
    expect(html).toContain("by model");
    expect(html).toContain("gpt-5");
    expect(html).toContain("claude-sonnet");
    expect(html).not.toMatch(/unknown[- ]source/iu);
  });

  it("renders the trajectory spine including the rejection loop", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain("trajectory");
    expect(html).toContain("write subtask 1");
    // rejected attempt
    expect(html).toContain("write subtask 2");
    // retry
    expect(html).toContain("write subtask 3");
    // the rejection is visible
    expect(html).toContain("auditor_disagreement");
    // rejected dot styled as failed
    expect(html).toContain('class="dot failed"');
  });

  it("renders the writer reasoning pane from typed events (intent, tools, redaction)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    // "writer's reasoning" (apostrophe HTML-escaped)
    expect(html).toContain("reasoning");
    // intent
    expect(html).toContain("wire the profile-sync hook behind a feature flag");
    // tool call
    expect(html).toContain("edit_file");
    // redactedPaths surfaced
    expect(html).toContain("hidden by redaction");
    // ask-forge CTA
    expect(html).toContain("ask forge");
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
    // it delegates via next() so the halted-run list claims the route.
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/runs/halted")).text();
    expect(html).toContain("halted runs");
    // not the run-detail body, not run-not-found
    expect(html).not.toContain("run not visible");
    expect(html).not.toContain("the agent");
  });

  it("renders run-not-found for an unknown run with honest 404", async () => {
    mockOrchestrator();
    const app = await build();
    const res = await app.request("/runs/run_does_not_exist");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("run not visible");
    expect(html).toContain('data-run-location="not_found"');
    expect(html).not.toContain('data-run-location="unavailable"');
  });

  it("renders unavailable (not not-found) when location probes error", async () => {
    mockOrchestrator();
    const prior = globalThis.fetch as typeof fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/runs/run_outage/location")) {
          return new Response(JSON.stringify({ error: "internal" }), { status: 503 });
        }
        return prior(input, init);
      }),
    );
    const app = await build();
    const res = await app.request("/runs/run_outage");
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("run location unavailable");
    expect(html).toContain('data-run-location="unavailable"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("run not visible");
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
// live preview-deploy pane in the review surface.
// ---------------------------------------------------------------------------

/**
 * Mock that ALSO answers the project-detail read (`getProject`) so the review
 * route can derive a preview URL from `config.previewUrlPattern`. When
 * `previewUrlPattern` is undefined the project parses with no preview field.
 */

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
    // project has no previewUrlPattern
    mockOrchestratorWithProject();
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

// ---------------------------------------------------------------------------
// gv-2 forge publication honesty: the forge-publication panel renders the
// honest tri-state. The proof is driven by production HTTP-derived payloads
// (review events inside the run-detail response the orchestrator ships), not a
// private helper-only assertion.
// ---------------------------------------------------------------------------

function reviewEvent(eventType: string, payload: Record<string, unknown>): RunEventRow {
  return {
    id: 9001,
    ts: new Date().toISOString(),
    runId: RUN_ID,
    taskId: null,
    specId: "spec_settings",
    projectId: PROJECT.projectId,
    eventType,
    payload,
    redactedPaths: [],
  };
}

/**
 * Stub the orchestrator so the run-detail HTTP response carries the given
 * terminal review events (appended to the base fixture's recentEvents). This is
 * the same path production takes — the dashboard derives the panel from the
 * HTTP-delivered `recentEvents`.
 */
function mockOrchestratorWithReviewEvents(reviewEvents: RunEventRow[]): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith(`/orgs/${ORG.id}/runs/${RUN_ID}/location`))
      return new Response(JSON.stringify({ orgId: ORG.id, projectId: PROJECT.projectId }), { status: 200 });
    if (/\/orgs\/[^/]+\/runs\/[^/]+\/location$/u.test(url)) {
      return new Response(JSON.stringify({ error: "run_not_found" }), { status: 404 });
    }
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream")) {
      return new Response(
        JSON.stringify({ ...RUN_DETAIL, recentEvents: [...RUN_DETAIL.recentEvents, ...reviewEvents] }),
        { status: 200 },
      );
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("gv-2 forge publication panel — honest tri-state (copy + severity)", () => {
  it("ZERO receipt fields → neutral unpublished (warn), never the danger partial-receipt copy", async () => {
    // Former bug: a human/auto terminal review.approved with no forge receipt
    // rendered as danger "partial forge fields present". Honest truth: there is
    // no receipt at all, so the neutral unpublished state must render.
    mockOrchestratorWithReviewEvents([reviewEvent("review.approved", { prUrl: "u", prNumber: 142 })]);
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain('data-review="forge-publication"');
    expect(html).toContain('data-state="unpublished"');
    expect(html).toContain("forge publication · unpublished");
    expect(html).toContain("no durable forge receipt");
    // NEVER the loud danger copy for a receipt-less event
    expect(html).not.toContain('data-state="malformed"');
    expect(html).not.toContain("incomplete receipt");
    expect(html).not.toContain("Partial forge fields present");
    // not painted as forge success either
    expect(html).not.toContain('data-state="published"');
  });

  it("a STRICT SUBSET of receipt fields → loud incomplete receipt (danger)", async () => {
    mockOrchestratorWithReviewEvents([
      reviewEvent("review.approved", { prUrl: "u", prNumber: 142, forgeReviewId: "9001" }),
    ]);
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain('data-state="malformed"');
    expect(html).toContain("forge publication · incomplete receipt");
    expect(html).toContain("Partial forge fields present");
    // never neutral unpublished, never success
    expect(html).not.toContain('data-state="unpublished"');
    expect(html).not.toContain('data-state="published"');
  });

  it("the FULL valid receipt tuple → published success with reviewer/id/head/link", async () => {
    const headSha = "c".repeat(40);
    mockOrchestratorWithReviewEvents([
      reviewEvent("review.approved", {
        prUrl: "u",
        prNumber: 142,
        reviewer: "tanren-reviewer[bot]",
        forgeReviewId: "9001",
        forgeReviewState: "approved",
        forgeReviewUrl: "https://github.com/o/r/pull/142#pullrequestreview-9001",
        headSha,
      }),
    ]);
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}/review`)).text();
    expect(html).toContain('data-state="published"');
    expect(html).toContain("forge publication · approved");
    expect(html).toContain("tanren-reviewer[bot]");
    expect(html).toContain('data-review="forge-reviewer"');
    expect(html).toContain('data-review="forge-review-id"');
    expect(html).toContain("9001");
    expect(html).toContain('data-review="forge-review-link"');
    expect(html).not.toContain('data-state="unpublished"');
    expect(html).not.toContain('data-state="malformed"');
  });
});
