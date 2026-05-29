// P2B-0008 — rendered-HTML acceptance tests for the halted-run failure-recovery
// surface. Mirrors the run-detail render harness: build the app with a stubbed
// pool + a mocked orchestrator (global fetch) and assert the server-rendered
// HTML and the same-origin recovery-action proxies. No live orchestrator/runner.
//
// The fixture is a fixture-medium run forced to halt by an auditor-disagreement
// scenario (outcome=retry_budget_exhausted), so the real-functionality bar —
// "a halted run can be recovered via revise + replan through the dashboard" —
// is exercised end to end against fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build, mockOrchestrator, recoveryCalls, RUN_ID, SPEC_ID } from "./recovery.render.fixtures.js";

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
      body: "steeringNote=split+behavior+5+into+5a+%2B+5b",
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
      body: "steeringNote=",
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
      body: "commitSha=9f3a2b4",
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
      body: "commitSha=9f3a2b4&confirmed=true",
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
