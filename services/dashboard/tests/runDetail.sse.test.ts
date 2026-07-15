// SSE proxy test with a FAKE upstream stream (no live orchestrator).
// The dashboard exposes a same-origin proxy at /runs/:runId/stream that forwards
// the orchestrator stream with the session cookie; the browser island
// subscribes to it. Here we stub fetch so the "orchestrator" returns a canned
// `event:/data:` SSE body and assert the proxy streams it through verbatim with
// the right content-type.

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
  projectId: "project_medium",
  name: "tanren-fixture-medium",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-medium",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const RUN_ID = "run_medium_001";

// A canned SSE body the fake orchestrator returns: a snapshot frame plus a
// costs delta and a terminal status frame — the shape the island reduces.
const FAKE_SSE_BODY = [
  `event: snapshot\ndata: ${JSON.stringify({ run: { runId: RUN_ID, status: "running", outcome: null }, tasks: [], recentEvents: [], costs: [{ billingMode: "per_token", model: "gpt-5", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, totalTokens: 150, costUsd: "0.0100" }] })}\n\n`,
  `event: costs\ndata: ${JSON.stringify({ costs: [{ billingMode: "subscription", model: "claude", inputTokens: 200, outputTokens: 80, cachedInputTokens: 0, totalTokens: 280, costUsd: null }] })}\n\n`,
  `event: status\ndata: ${JSON.stringify({ runId: RUN_ID, status: "completed", outcome: "ok" })}\n\n`,
].join("");

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (url.endsWith(`/orgs/${ORG.id}/runs/${RUN_ID}/location`))
      return new Response(JSON.stringify({ orgId: ORG.id, projectId: PROJECT.projectId }), { status: 200 });
    if (/\/orgs\/[^/]+\/runs\/[^/]+\/location$/u.test(url)) {
      return new Response(JSON.stringify({ error: "run_not_found" }), { status: 404 });
    }
    if (url.includes(`/runs/${RUN_ID}/stream`)) {
      return new Response(FAKE_SSE_BODY, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
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

describe("P2B-0004 SSE proxy (fake stream)", () => {
  it("proxies the orchestrator stream verbatim as text/event-stream", async () => {
    mockOrchestrator();
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const res = await app.request(`/runs/${RUN_ID}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: snapshot");
    expect(body).toContain("event: costs");
    expect(body).toContain("event: status");
    expect(body).toContain("ok");
  });

  it("returns 404 for a run the operator cannot see", async () => {
    mockOrchestrator();
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const res = await app.request(`/runs/run_unknown/stream`);
    expect(res.status).toBe(404);
  });
});
