// Mutation-ratchet behavior tests for the operator-facing NARRATIVE surface of
// the insight detectors — the title/body strings, the action labels + toolCall
// args, the human-duration/hour formatting, and the model-mismatch savings/ratio
// arithmetic. Every assertion reads back a real emitted string or number, so a
// surviving Stryker mutant on a template fragment, a ternary, a `?? fallback`,
// or a `* / + -` operator in those paths changes a value the test pins. Plus the
// dora reducer's zero-gap boundary and the computer dispatcher routing.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  computeInsight,
  computeModelMismatch,
  computePaceAnomaly,
  computeReviewStall,
  computeRetryHotspot,
  computeStuck,
  type Insight,
} from "../src/engine/insights/index.js";
import { deriveDoraMetrics, type DeriveOptions, type DoraInputs } from "../src/engine/insights/dora/index.js";
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
type RetryPayload = Extract<Insight["payload"], { kind: "retry_hotspot" }>;

function seedMismatchClass(
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
    client.costs.push({
      task_id: task,
      run_id: run,
      cli: "codex",
      model,
      cost_usd: perSpecCost,
      recorded_at: endedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// stuck — title pluralization + body chain text + action toolCall args.
// ---------------------------------------------------------------------------
describe("computeStuck — narrative + actions", () => {
  it("pluralizes the title for two blockers and lists both names in the body", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "ui", title: "Build UI", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "api", title: "Build API", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "auth", title: "Build Auth", project_id: "project_a", status: "in_flight" });
    client.specDependencies.push({ from_spec_id: "ui", to_spec_id: "api" });
    client.specDependencies.push({ from_spec_id: "ui", to_spec_id: "auth" });
    const insights = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    const head = insights.find((i) => (i.payload as StuckPayload).blockedSpecId === "ui")!;
    expect(head.title).toContain("Build UI blocked on 2 dependencies");
    expect(head.body).toContain("Build API");
    expect(head.body).toContain("Build Auth");
    // The first action opens the blocked spec; the second acknowledges THIS id.
    expect(head.actions[0]!.toolCall).toMatchObject({ tool: "tanren.read_run", args: { specId: "ui" } });
    expect(head.actions[1]!.toolCall).toMatchObject({
      tool: "tanren.acknowledge_insight",
      args: { insightId: head.id },
    });
  });

  it("uses 'now ?? new Date()' so an injected NOW is the computedAt instant", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "a", title: "A", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "b", title: "B", project_id: "project_a", status: "open" });
    client.specDependencies.push({ from_spec_id: "a", to_spec_id: "b" });
    const insights = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    expect(insights[0]!.computedAt.getTime()).toBe(NOW.getTime());
  });
});

// ---------------------------------------------------------------------------
// review_stall — prRef ternary, phaseLabel, humanHours h/d formatting, action.
// ---------------------------------------------------------------------------
describe("computeReviewStall — narrative + formatting", () => {
  function seedReview(client: InsightsMemoryClient, eventType: string, prNumber: number, hours: number): void {
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: eventType,
      payload: prNumber > 0 ? { prNumber, prUrl: "https://x/pull/7" } : {},
      ts: hoursAgo(hours),
    });
  }

  it("renders 'PR #N' and 'awaiting review' for a numbered awaiting-review stall", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.requested", 42, 72);
    const r = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(r[0]!.title).toContain("PR #42 awaiting review");
    expect(r[0]!.body).toContain("threshold 48h");
    expect(r[0]!.actions[0]!.toolCall).toMatchObject({ tool: "tanren.read_run", args: { specId: "spec_a" } });
  });

  it("falls back to 'the PR' when no prNumber is present (the prNumber > 0 ternary)", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.changes_requested", 0, 72);
    const r = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(r[0]!.title).toContain("the PR changes requested");
    expect(r[0]!.title).not.toContain("PR #");
  });

  it("formats sub-48h stalls in hours and >=48h stalls in days", async () => {
    const hoursCase = new InsightsMemoryClient();
    // 30h with a 24h custom threshold -> "30h" (humanHours < 48).
    seedReview(hoursCase, "review.requested", 1, 30);
    const rh = await computeReviewStall(pool(hoursCase), {
      projectId: "project_a",
      now: NOW,
      thresholds: { reviewStallHours: 24 },
    });
    expect(rh[0]!.title).toContain("30h");

    const daysCase = new InsightsMemoryClient();
    // 96h -> 4.0d.
    seedReview(daysCase, "review.requested", 1, 96);
    const rd = await computeReviewStall(pool(daysCase), { projectId: "project_a", now: NOW });
    expect(rd[0]!.title).toContain("4d");
  });

  it("rounds stalledHours to one decimal in the payload", async () => {
    const client = new InsightsMemoryClient();
    seedReview(client, "review.requested", 1, 50.27);
    const r = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect((r[0]!.payload as Extract<Insight["payload"], { kind: "review_stall" }>).stalledHours).toBe(50.3);
  });
});

// ---------------------------------------------------------------------------
// retry_hotspot — model fallback, rejection-summary body, action descriptions.
// ---------------------------------------------------------------------------
describe("computeRetryHotspot — narrative + fallbacks", () => {
  function seed(client: InsightsMemoryClient, model: string | null, withReason: boolean): void {
    client.specs.push({ spec_id: "spec_a", title: "Add SSO", project_id: "project_a" });
    client.runs.push({ run_id: "run_a", spec_id: "spec_a", project_id: "project_a", outcome: null, ended_at: null });
    for (let i = 0; i < 2; i += 1) {
      client.tasks.push({
        task_id: `t_${i}`,
        run_id: "run_a",
        agent_kind: "writer",
        cli: "codex",
        model,
        status: "done",
        outcome: "failed",
        started_at: daysAgo(1),
        ended_at: daysAgo(1),
        attempt: i + 1,
        parent_task_id: null,
      });
    }
    if (withReason) {
      client.events.push({
        spec_id: "spec_a",
        task_id: null,
        event_type: "planner.rerequested",
        payload: { rejectionReason: "auditor rejected behavior Y" },
        ts: daysAgo(1),
      });
    }
  }

  it("falls back writerModel to 'unknown' when the task model is null", async () => {
    const client = new InsightsMemoryClient();
    seed(client, null, false);
    const r = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect((r[0]!.payload as RetryPayload).writerModel).toBe("unknown");
    expect(r[0]!.body).toContain("unknown");
  });

  it("includes the recent rejection summary in the body when present", async () => {
    const client = new InsightsMemoryClient();
    seed(client, "gpt-5", true);
    const r = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    const payload = r[0]!.payload as RetryPayload;
    expect(payload.rejectionSummaries[0]).toContain("auditor rejected");
    expect(r[0]!.body).toContain("Recent rejections: auditor rejected behavior Y");
    // The refine action carries the rejection reason into the spec description.
    expect(JSON.stringify(r[0]!.actions[0]!.toolCall)).toContain("auditor rejected behavior Y");
  });

  it("uses the generic body (no 'Recent rejections') when there is no reason", async () => {
    const client = new InsightsMemoryClient();
    seed(client, "gpt-5", false);
    const r = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect(r[0]!.body).toContain("2 attempts");
    expect(r[0]!.body).not.toContain("Recent rejections");
  });

  it("titles the retry count and window days", async () => {
    const client = new InsightsMemoryClient();
    seed(client, "gpt-5", false);
    const r = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect(r[0]!.title).toContain("Add SSO retried 2× in 7d");
  });
});

// ---------------------------------------------------------------------------
// pace_anomaly — humanDuration s/m/h formatting + subtaskIndex lookup.
// ---------------------------------------------------------------------------
describe("computePaceAnomaly — narrative + subtask index", () => {
  function seed(
    client: InsightsMemoryClient,
    elapsedSeconds: number,
    avgSeconds: number,
    subtaskIndex: number | null,
  ): void {
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
    client.specs.push({ spec_id: "live", title: "Live spec", project_id: "project_a" });
    client.specMilestones.push({ spec_id: "live", milestone_id: "m_1" });
    client.runs.push({ run_id: "run_live", spec_id: "live", project_id: "project_a", outcome: null, ended_at: null });
    client.tasks.push({
      task_id: "t_live",
      run_id: "run_live",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "running",
      outcome: null,
      started_at: new Date(NOW.getTime() - elapsedSeconds * 1000),
      ended_at: null,
      attempt: 1,
      // A subtask writer carries a parent planner task id.
      parent_task_id: subtaskIndex === null ? null : "planner_live",
    });
    if (subtaskIndex !== null) {
      client.events.push({
        spec_id: null,
        task_id: "t_live",
        event_type: "writer.subtask.started",
        payload: { subtaskIndex },
        ts: new Date(NOW.getTime() - elapsedSeconds * 1000),
      });
    }
  }

  it("reads the subtaskIndex from the writer.subtask.started event for a subtask writer", async () => {
    const client = new InsightsMemoryClient();
    seed(client, 7200, 60, 4);
    const r = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    const payload = r[0]!.payload as Extract<Insight["payload"], { kind: "pace_anomaly" }>;
    expect(payload.subtaskIndex).toBe(4);
    // 7200s -> 2.0h in the body (humanDuration >= 3600 uses hours).
    expect(r[0]!.body).toContain("2h");
    expect(r[0]!.actions[0]!.toolCall).toMatchObject({ tool: "tanren.read_run", args: { runId: "run_live" } });
  });

  it("defaults subtaskIndex to 0 for a legacy top-level writer task (no parent)", async () => {
    const client = new InsightsMemoryClient();
    seed(client, 1200, 60, null);
    const r = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    const payload = r[0]!.payload as Extract<Insight["payload"], { kind: "pace_anomaly" }>;
    expect(payload.subtaskIndex).toBe(0);
    // 1200s -> 20m (humanDuration 60..3600 uses minutes).
    expect(r[0]!.body).toContain("20m");
  });
});

// ---------------------------------------------------------------------------
// model_mismatch — monthlySavings + title ratio arithmetic.
// ---------------------------------------------------------------------------
describe("computeModelMismatch — savings + ratio arithmetic", () => {
  it("computes monthlySavings = (current - cheapest) × max(currentMergedSpecs, 1) and a 3.0× title", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    // cheapest $0.50/spec, current $1.50/spec, both with 3 merged specs.
    seedMismatchClass(client, "cheap", 0.5, daysAgo(20), "c");
    seedMismatchClass(client, "pricey", 1.5, daysAgo(2), "e");
    const r = await computeModelMismatch(pool(client), { projectId: "project_a", now: NOW });
    const payload = r[0]!.payload as Extract<Insight["payload"], { kind: "model_mismatch" }>;
    // (1.5 - 0.5) × 3 = 3.0 savings.
    expect(payload.monthlySavings).toBeCloseTo(3, 6);
    // 1.5 / 0.5 = 3.0× in the title.
    expect(r[0]!.title).toContain("3.0×");
    expect(payload.currentCostPerMergedSpec).toBeCloseTo(1.5, 6);
    expect(payload.alternativeCostPerMergedSpec).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// dora — zero-gap boundary (s >= 0 must INCLUDE a zero gap).
// ---------------------------------------------------------------------------
describe("deriveDoraMetrics — zero-gap boundary", () => {
  const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
  const OPTIONS: DeriveOptions = {
    projectId: "project_a",
    windowStart: new Date(WINDOW_END.getTime() - 30 * 24 * 60 * 60 * 1000),
    windowEnd: WINDOW_END,
    windowDays: 30,
  };
  const EMPTY: DoraInputs = { merges: [], finishedRuns: [], recoveries: [] };

  it("includes a zero-second lead time (the s >= 0 filter keeps the boundary)", () => {
    const sameInstant = new Date("2026-05-20T00:00:00Z");
    const merges = [
      { specId: "z", specCreatedAt: sameInstant, mergedAt: sameInstant },
      { specId: "b", specCreatedAt: sameInstant, mergedAt: new Date(sameInstant.getTime() + 2 * 3600_000) },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, merges }, OPTIONS);
    // Both kept: median(0h, 2h) = 1h; sample 2 (zero is NOT dropped).
    expect(m.leadTimeSeconds.sample).toBe(2);
    expect(m.leadTimeSeconds.value).toBe(1 * 3600);
  });

  it("includes a zero-second restore time for MTTR", () => {
    const t = new Date("2026-05-15T00:00:00Z");
    const recoveries = [
      { specId: "z", haltedAt: t, recoveredAt: t },
      { specId: "b", haltedAt: t, recoveredAt: new Date(t.getTime() + 4 * 3600_000) },
    ];
    const m = deriveDoraMetrics({ ...EMPTY, recoveries }, OPTIONS);
    expect(m.totals.recoveries).toBe(2);
    expect(m.meanTimeToRestoreSeconds.value).toBe(2 * 3600);
  });
});

// ---------------------------------------------------------------------------
// computer — kind -> compute-function dispatch.
// ---------------------------------------------------------------------------
describe("computeInsight — dispatch routing", () => {
  it("routes 'stuck' to the stuck detector (emits a stuck insight)", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "a", title: "A", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "b", title: "B", project_id: "project_a", status: "open" });
    client.specDependencies.push({ from_spec_id: "a", to_spec_id: "b" });
    const r = await computeInsight("stuck", { projectId: "project_a", now: NOW }, pool(client));
    expect(r.every((i) => i.kind === "stuck")).toBe(true);
    expect(r.length).toBeGreaterThan(0);
  });

  it("routes 'review_stall' to the review-stall detector", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 1, prUrl: "u" },
      ts: hoursAgo(72),
    });
    const r = await computeInsight("review_stall", { projectId: "project_a", now: NOW }, pool(client));
    expect(r[0]!.kind).toBe("review_stall");
  });
});
