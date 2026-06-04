// Demos-as-evidence engine coverage (design doc § "Native Deployment And Demos"):
// the demo engine exercises each of the spec's BEHAVIORS against a deployed surface
// and records VERIFIABLE per-behavior evidence (pass + fail), emitting one
// demo.evidence.recorded per behavior + a demo.completed summary — all non-secret,
// all org-scoped. Driven over a SCRIPTED web probe (no live HTTP) + a recording event
// store (no Postgres). The narration is then layered ON TOP of the recorded evidence.

import { describe, expect, it } from "vitest";
import { getJobOrgId } from "@tanren/db";
import { DemoEngine, type DemoBehavior } from "../src/engine/demo/demoEngine.js";
import type { DemoWebProbe, BehaviorEvidence } from "../src/engine/demo/demoEvidence.js";
import { templateDemoNarration } from "../src/engine/demo/narration.js";
import type { DemoSurface } from "../src/engine/contracts/deployAdapter.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";

const TARGET = { runId: "run_demo", specId: "spec_demo", projectId: "proj_demo", orgId: "org_demo" };
const SURFACE: DemoSurface = { kind: "web_url", url: "https://acme-web.vercel.app" };

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown>; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      ambientOrgId: getJobOrgId(),
    });
  }
}

// A web probe scripted PER PATH: each behavior's resolved route gets a fixed status
// (so one behavior can pass while another fails), and it records every probed URL.
function scriptedProbe(byPath: Record<string, number>): DemoWebProbe & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    // eslint-disable-next-line @typescript-eslint/require-await
    async reach(url: string): Promise<number> {
      probed.push(url);
      const path = new URL(url).pathname;
      const status = byPath[path];
      if (status === undefined) throw new Error(`connection refused`);
      return status;
    },
  };
}

const behavior = (id: string, title: string, surfacePath?: string): DemoBehavior => ({
  behaviorId: id,
  behaviorTitle: title,
  metadata: surfacePath === undefined ? {} : { surfacePath },
});

describe("DemoEngine — per-behavior evidence", () => {
  it("exercises each behavior against the surface + records pass AND fail evidence", async () => {
    const events = new RecordingEventStore();
    const probe = scriptedProbe({ "/links": 200, "/admin": 503 });
    const engine = new DemoEngine({ events, webProbe: probe });

    const result = await engine.exercise(TARGET, SURFACE, [
      behavior("beh_links", "Create a short link", "/links"),
      behavior("beh_admin", "View the admin dashboard", "/admin"),
    ]);

    // The probe hit each behavior's RESOLVED route on the deploy host.
    expect(probe.probed).toEqual(["https://acme-web.vercel.app/links", "https://acme-web.vercel.app/admin"]);
    // Per-behavior verdicts: 200 → passed, 503 → failed.
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    const byId = Object.fromEntries(result.evidence.map((e) => [e.behaviorId, e]));
    expect(byId["beh_links"]!.outcome).toBe("passed");
    expect(byId["beh_links"]!.detail).toBe("GET /links → HTTP 200");
    expect(byId["beh_admin"]!.outcome).toBe("failed");

    // One demo.evidence.recorded per behavior + a demo.completed summary, org-scoped.
    const recorded = events.appends.filter((a) => a.eventType === "demo.evidence.recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded.every((a) => a.ambientOrgId === "org_demo")).toBe(true);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary).toBeDefined();
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", behaviorCount: 2, passed: 1, failed: 1 });
    expect(summary!.ambientOrgId).toBe("org_demo");
  });

  it("exercises the surface ROOT for a behavior with no described path", async () => {
    const events = new RecordingEventStore();
    const probe = scriptedProbe({ "/": 200 });
    const engine = new DemoEngine({ events, webProbe: probe });
    const result = await engine.exercise(TARGET, SURFACE, [behavior("beh_root", "Home page loads")]);
    expect(probe.probed).toEqual(["https://acme-web.vercel.app/"]);
    expect(result.evidence[0]!.outcome).toBe("passed");
  });

  it("records a transport failure as FAILED evidence (never aborts the demo)", async () => {
    const events = new RecordingEventStore();
    // /down is not scripted ⇒ the probe throws (connection refused).
    const probe = scriptedProbe({ "/up": 200 });
    const engine = new DemoEngine({ events, webProbe: probe });
    const result = await engine.exercise(TARGET, SURFACE, [
      behavior("beh_up", "Up route", "/up"),
      behavior("beh_down", "Down route", "/down"),
    ]);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    const down = result.evidence.find((e) => e.behaviorId === "beh_down");
    expect(down!.outcome).toBe("failed");
    expect(down!.detail).toContain("unreachable");
  });

  it("records a demo.completed with zero counts for a spec with no behaviors (never a silent skip)", async () => {
    const events = new RecordingEventStore();
    const engine = new DemoEngine({ events, webProbe: scriptedProbe({}) });
    const result = await engine.exercise(TARGET, SURFACE, []);
    expect(result.evidence).toEqual([]);
    expect(events.appends.filter((a) => a.eventType === "demo.evidence.recorded")).toEqual([]);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ behaviorCount: 0, passed: 0, failed: 0 });
  });

  it("never leaks a secret-looking value into the evidence payloads", async () => {
    const events = new RecordingEventStore();
    const probe = scriptedProbe({ "/x": 200 });
    const engine = new DemoEngine({ events, webProbe: probe });
    await engine.exercise(TARGET, SURFACE, [behavior("beh_x", "X", "/x")]);
    // The detail is the observable shape only — a probe never returns a body/token here.
    expect(JSON.stringify(events.appends)).not.toMatch(/token|secret|bearer/iu);
  });
});

describe("narration layered ON TOP of demo evidence", () => {
  const evidence: BehaviorEvidence[] = [
    {
      behaviorId: "beh_links",
      behaviorTitle: "Create a short link",
      surfaceKind: "web_url",
      outcome: "passed",
      detail: "GET /links → HTTP 200",
    },
    {
      behaviorId: "beh_admin",
      behaviorTitle: "View the admin dashboard",
      surfaceKind: "web_url",
      outcome: "failed",
      detail: "GET /admin → HTTP 503",
    },
  ];

  it("summarizes the verifiable evidence: passed behaviors highlighted, failed → show-stopper risks", () => {
    const answer = templateDemoNarration({
      specTitle: "URL shortener",
      specDescription: "Create and resolve short links.",
      behaviors: [],
      unresolvedRisks: [],
      evidence,
      timeoutMs: 1_000,
    });
    // The prose reports the live tally, highlights only the PASSED behavior, and turns
    // the FAILED behavior into an honest show-stopper risk.
    expect(answer.headline).toContain("1/2");
    expect(answer.body).toContain("1 passed, 1 failed");
    expect(answer.highlightBehaviorIds).toEqual(["beh_links"]);
    expect(answer.showStopperRisks.join(" ")).toContain("View the admin dashboard");
  });
});
