// Mutation-ratchet behavior tests for the insight detectors
// (`engine/insights/{stuck,reviewStall,paceAnomaly,modelMismatch,retryHotspot}`).
// Each test seeds the InsightsMemoryClient and asserts the emitted Insight's
// observable fields — the threshold/severity classification, the chain-depth
// count, the phase mapping, the cheapest/most-recent selection, and the
// human-duration formatting — so a surviving Stryker mutant on a comparison
// operator, a multiplier, a status-set member, or a reducer flips a value the
// test reads back. Plus the `types.ts` superRefine kind-mismatch guard.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  computeModelMismatch,
  computePaceAnomaly,
  computeReviewStall,
  computeRetryHotspot,
  computeStuck,
  Insight,
} from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");
function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}
function daysAgo(d: number): Date {
  return new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
}

type StuckPayload = Extract<Insight["payload"], { kind: "stuck" }>;
type ReviewPayload = Extract<Insight["payload"], { kind: "review_stall" }>;
type PacePayload = Extract<Insight["payload"], { kind: "pace_anomaly" }>;
type MismatchPayload = Extract<Insight["payload"], { kind: "model_mismatch" }>;
type RetryPayload = Extract<Insight["payload"], { kind: "retry_hotspot" }>;

function seedChain(client: InsightsMemoryClient, ids: string[], statuses: string[]): void {
  ids.forEach((id, i) => {
    client.specs.push({ spec_id: id, title: id.toUpperCase(), project_id: "project_a", status: statuses[i]! });
  });
  for (let i = 0; i < ids.length - 1; i += 1) {
    client.specDependencies.push({ from_spec_id: ids[i]!, to_spec_id: ids[i + 1]! });
  }
}

function seedReview(client: InsightsMemoryClient, eventType: string, ts: Date): void {
  client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
  client.events.push({
    spec_id: "spec_a",
    task_id: null,
    event_type: eventType,
    payload: { prNumber: 5, prUrl: "https://x/pull/5" },
    ts,
  });
}

function seedPace(client: InsightsMemoryClient, elapsedSeconds: number, avgSeconds: number): void {
  client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
  for (let i = 0; i < 3; i += 1) {
    const spec = `done_${i}`;
    client.specs.push({ spec_id: spec, title: spec, project_id: "project_a" });
    client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
    client.runs.push({
      run_id: `r_${i}`,
      spec_id: spec,
      project_id: "project_a",
      outcome: "merged",
      ended_at: daysAgo(1),
    });
    client.tasks.push({
      task_id: `t_${i}`,
      run_id: `r_${i}`,
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "passed",
      started_at: new Date(daysAgo(1).getTime() - avgSeconds * 1000),
      ended_at: daysAgo(1),
      attempt: 1,
      parent_task_id: null,
    });
  }
  client.specs.push({ spec_id: "live", title: "Live", project_id: "project_a" });
  client.specMilestones.push({ spec_id: "live", milestone_id: "m_1" });
  client.runs.push({ run_id: "r_live", spec_id: "live", project_id: "project_a", outcome: null, ended_at: null });
  client.tasks.push({
    task_id: "t_live",
    run_id: "r_live",
    agent_kind: "writer",
    cli: "codex",
    model: "gpt-5",
    status: "running",
    outcome: null,
    started_at: new Date(NOW.getTime() - elapsedSeconds * 1000),
    ended_at: null,
    attempt: 1,
    parent_task_id: null,
  });
}

function seedClass(
  client: InsightsMemoryClient,
  model: string,
  perSpecCost: number,
  endedAt: Date,
  prefix: string,
): void {
  for (let i = 0; i < 3; i += 1) {
    const spec = `${prefix}_${i}`;
    client.specs.push({ spec_id: spec, title: spec, project_id: "project_a" });
    client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
    const run = `run_${prefix}_${i}`;
    client.runs.push({ run_id: run, spec_id: spec, project_id: "project_a", outcome: "merged", ended_at: endedAt });
    const task = `task_${prefix}_${i}`;
    client.tasks.push({
      task_id: task,
      run_id: run,
      agent_kind: "writer",
      cli: "codex",
      model,
      status: "done",
      outcome: "passed",
      started_at: endedAt,
      ended_at: endedAt,
      attempt: 1,
      parent_task_id: null,
    });
    client.costs.push({ task_id: task, run_id: run, cli: "codex", model, cost_usd: perSpecCost, recorded_at: endedAt });
  }
}

function seedAttempts(client: InsightsMemoryClient, count: number, started: Date): void {
  client.specs.push({ spec_id: "spec_a", title: "Add SSO", project_id: "project_a" });
  client.runs.push({ run_id: "run_a", spec_id: "spec_a", project_id: "project_a", outcome: null, ended_at: null });
  for (let i = 0; i < count; i += 1) {
    client.tasks.push({
      task_id: `t_${i}`,
      run_id: "run_a",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "failed",
      started_at: started,
      ended_at: started,
      attempt: i + 1,
      parent_task_id: null,
    });
  }
}

// ---------------------------------------------------------------------------
// stuck — chain depth + severity threshold + finished-status set.
// ---------------------------------------------------------------------------
describe("computeStuck — chain depth and severity", () => {
  function headFor(insights: Insight[], blockedSpecId: string): Insight {
    return insights.find((i) => (i.payload as StuckPayload).blockedSpecId === blockedSpecId)!;
  }

  it("stays info at chainDepth 2 and escalates to warn at chainDepth 3 (the >= 3 boundary)", async () => {
    const two = new InsightsMemoryClient();
    seedChain(two, ["a", "b"], ["open", "open"]);
    const headA = headFor(await computeStuck(pool(two), { projectId: "project_a", now: NOW }), "a");
    expect((headA.payload as StuckPayload).chainDepth).toBe(2);
    expect(headA.severity).toBe("info");

    const three = new InsightsMemoryClient();
    seedChain(three, ["a", "b", "c"], ["open", "open", "open"]);
    const headA3 = headFor(await computeStuck(pool(three), { projectId: "project_a", now: NOW }), "a");
    expect((headA3.payload as StuckPayload).chainDepth).toBe(3);
    expect(headA3.severity).toBe("warn");
  });

  it("excludes a FINISHED dependency from the blocking list and the depth count", async () => {
    const client = new InsightsMemoryClient();
    // a -> b(open) and a -> c(done): only b blocks; chain depth from a is 2 (a,b).
    client.specs.push({ spec_id: "a", title: "A", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "b", title: "B", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "c", title: "C", project_id: "project_a", status: "done" });
    client.specDependencies.push({ from_spec_id: "a", to_spec_id: "b" });
    client.specDependencies.push({ from_spec_id: "a", to_spec_id: "c" });
    const head = headFor(await computeStuck(pool(client), { projectId: "project_a", now: NOW }), "a");
    const payload = head.payload as StuckPayload;
    expect(payload.blockingSpecs.map((b) => b.specId)).toEqual(["b"]);
    expect(payload.chainDepth).toBe(2);
    expect(head.title).toContain("1 dependency");
  });

  it("treats each of merged/done/cancelled as finished (no insight when all deps finished)", async () => {
    for (const finished of ["merged", "done", "cancelled"]) {
      const client = new InsightsMemoryClient();
      client.specs.push({ spec_id: "a", title: "A", project_id: "project_a", status: "open" });
      client.specs.push({ spec_id: "b", title: "B", project_id: "project_a", status: finished });
      client.specDependencies.push({ from_spec_id: "a", to_spec_id: "b" });
      expect(await computeStuck(pool(client), { projectId: "project_a", now: NOW })).toHaveLength(0);
    }
  });

  it("does not emit for a blocked spec that is itself already finished", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "a", title: "A", project_id: "project_a", status: "done" });
    client.specs.push({ spec_id: "b", title: "B", project_id: "project_a", status: "open" });
    client.specDependencies.push({ from_spec_id: "a", to_spec_id: "b" });
    expect(await computeStuck(pool(client), { projectId: "project_a", now: NOW })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// review_stall — phase mapping, threshold boundary, 2x severity, hour/day text.
// ---------------------------------------------------------------------------
describe("computeReviewStall — threshold and severity", () => {
  it("does NOT emit below the threshold and emits AT the threshold", async () => {
    const below = new InsightsMemoryClient();
    seedReview(below, "review.requested", hoursAgo(47.99));
    expect(await computeReviewStall(pool(below), { projectId: "project_a", now: NOW })).toHaveLength(0);

    const atThreshold = new InsightsMemoryClient();
    seedReview(atThreshold, "review.requested", hoursAgo(48));
    const r = await computeReviewStall(pool(atThreshold), { projectId: "project_a", now: NOW });
    expect(r).toHaveLength(1);
    expect((r[0]!.payload as ReviewPayload).phase).toBe("awaiting_review");
    // 48h < 2*48 -> info (the 2x severity boundary).
    expect(r[0]!.severity).toBe("info");
  });

  it("escalates to warn at exactly 2× the threshold", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.changes_requested", hoursAgo(96));
    const r = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect((r[0]!.payload as ReviewPayload).phase).toBe("changes_requested");
    expect(r[0]!.severity).toBe("warn");
  });

  it("renders days (not hours) in the title once stalled at/over 48h", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.requested", hoursAgo(72));
    const r = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    // 72h -> 3.0d (>= 48 uses day formatting).
    expect(r[0]!.title).toContain("3d");
    expect(r[0]!.title).not.toContain("72h");
  });

  it("respects a custom reviewStallHours threshold from context", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.requested", hoursAgo(10));
    const r = await computeReviewStall(pool(client), {
      projectId: "project_a",
      now: NOW,
      thresholds: { reviewStallHours: 6 },
    });
    expect(r).toHaveLength(1);
    expect((r[0]!.payload as ReviewPayload).thresholdHours).toBe(6);
  });

  it("stays silent when the newest signal is an approval even if an old request stalled", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 5, prUrl: "u" },
      ts: hoursAgo(200),
    });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.approved",
      payload: { prNumber: 5, prUrl: "u" },
      ts: hoursAgo(1),
    });
    expect(await computeReviewStall(pool(client), { projectId: "project_a", now: NOW })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pace_anomaly — multiplier threshold + 1.5x severity.
// ---------------------------------------------------------------------------
describe("computePaceAnomaly — multiplier threshold and severity", () => {
  it("does NOT emit just below 2× and emits AT 2× the class average", async () => {
    const below = new InsightsMemoryClient();
    // 119s elapsed vs 60s average is 1.98× — under the 2× threshold.
    seedPace(below, 119, 60);
    expect(await computePaceAnomaly(pool(below), { projectId: "project_a", now: NOW })).toHaveLength(0);

    const atThreshold = new InsightsMemoryClient();
    // 120s vs 60s is exactly 2×.
    seedPace(atThreshold, 120, 60);
    const r = await computePaceAnomaly(pool(atThreshold), { projectId: "project_a", now: NOW });
    expect(r).toHaveLength(1);
    const payload = r[0]!.payload as PacePayload;
    expect(payload.multiplier).toBeCloseTo(2, 2);
    expect(payload.classAverageSeconds).toBe(60);
    expect(payload.elapsedSeconds).toBe(120);
    // 2× < 2×1.5=3× -> info.
    expect(r[0]!.severity).toBe("info");
  });

  it("escalates to warn at 1.5× the multiplier threshold (3× the average)", async () => {
    const client = new InsightsMemoryClient();
    // 180s vs 60s is exactly 3× = 1.5 × the 2× threshold.
    seedPace(client, 180, 60);
    const r = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    expect(r[0]!.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// model_mismatch — cheapest/most-recent selection + ratio boundary.
// ---------------------------------------------------------------------------
describe("computeModelMismatch — selection and ratio", () => {
  it("stays silent just below the cost ratio and emits AT exactly the ratio", async () => {
    const below = new InsightsMemoryClient();
    below.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    seedClass(below, "cheap", 0.5, daysAgo(20), "c");
    // 0.99 / 0.5 = 1.98× — under the 2× ratio.
    seedClass(below, "pricey", 0.99, daysAgo(2), "e");
    expect(await computeModelMismatch(pool(below), { projectId: "project_a", now: NOW })).toHaveLength(0);

    const atRatio = new InsightsMemoryClient();
    atRatio.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    seedClass(atRatio, "cheap", 0.5, daysAgo(20), "c");
    // 1.0 / 0.5 = exactly 2×.
    seedClass(atRatio, "pricey", 1.0, daysAgo(2), "e");
    const r = await computeModelMismatch(pool(atRatio), { projectId: "project_a", now: NOW });
    expect(r).toHaveLength(1);
    const payload = r[0]!.payload as MismatchPayload;
    // most-recent (pricey) is current; cheapest is the alternative.
    expect(payload.currentModel).toBe("pricey");
    expect(payload.alternativeModel).toBe("cheap");
    expect(payload.currentCostPerMergedSpec).toBeCloseTo(1, 6);
    expect(payload.alternativeCostPerMergedSpec).toBeCloseTo(0.5, 6);
    expect(r[0]!.severity).toBe("warn");
  });

  it("stays silent when the most-recently-used model IS the cheapest", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    // The cheap model is also the most recent, so there is nothing to switch to.
    seedClass(client, "pricey", 1.0, daysAgo(20), "e");
    seedClass(client, "cheap", 0.2, daysAgo(1), "c");
    expect(await computeModelMismatch(pool(client), { projectId: "project_a", now: NOW })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// retry_hotspot — count threshold + severity step + window.
// ---------------------------------------------------------------------------
describe("computeRetryHotspot — count and severity", () => {
  it("does NOT emit at 1 attempt but emits at the min (2), info at 2, warn at 3", async () => {
    const one = new InsightsMemoryClient();
    seedAttempts(one, 1, daysAgo(1));
    expect(await computeRetryHotspot(pool(one), { projectId: "project_a", now: NOW })).toHaveLength(0);

    const two = new InsightsMemoryClient();
    seedAttempts(two, 2, daysAgo(1));
    const r2 = await computeRetryHotspot(pool(two), { projectId: "project_a", now: NOW });
    expect(r2).toHaveLength(1);
    expect((r2[0]!.payload as RetryPayload).retryCount).toBe(2);
    expect(r2[0]!.severity).toBe("info");

    const three = new InsightsMemoryClient();
    seedAttempts(three, 3, daysAgo(1));
    const r3 = await computeRetryHotspot(pool(three), { projectId: "project_a", now: NOW });
    expect(r3[0]!.severity).toBe("warn");
  });

  it("excludes attempts that started before the window", async () => {
    const client = new InsightsMemoryClient();
    // Window is 7 days; these started 30 days ago.
    seedAttempts(client, 3, daysAgo(30));
    expect(await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// types.ts — superRefine cross-field guard (was NoCoverage).
// ---------------------------------------------------------------------------
describe("Insight schema — kind/payload cross-field refinement", () => {
  const base = {
    id: "insight_x",
    projectId: "project_a",
    severity: "info" as const,
    title: "T",
    body: "B",
    actions: [],
    computedAt: NOW,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  const stuckPayload = {
    kind: "stuck" as const,
    blockedSpecId: "a",
    blockedSpecTitle: "A",
    blockingSpecs: [{ specId: "b", title: "B", status: "open" }],
    chainDepth: 2,
  };

  it("accepts a row whose top-level kind matches the payload kind", () => {
    expect(() => Insight.parse({ ...base, kind: "stuck", payload: stuckPayload })).not.toThrow();
  });

  it("REJECTS a row whose kind disagrees with the payload kind", () => {
    expect(() => Insight.parse({ ...base, kind: "review_stall", payload: stuckPayload })).toThrow(
      /must match payload\.kind/u,
    );
  });
});
