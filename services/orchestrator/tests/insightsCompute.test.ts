// P2A-0020 per-kind compute tests using the InsightsMemoryClient fixture.
//
// The Phase 1 fixture data produces zero insights — no retries, no model
// variance, no slow in-flight tasks. We assert that exact shape, then layer
// synthetic data that should trigger each kind.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  computeModelMismatch,
  computePaceAnomaly,
  computeRetryHotspot,
  Insight
} from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("computeRetryHotspot", () => {
  it("returns no insights for a phase-1-shaped clean run", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.runs.push({
      run_id: "run_1",
      spec_id: "spec_a",
      project_id: "project_a",
      outcome: "merged",
      ended_at: daysAgo(1)
    });
    client.tasks.push({
      task_id: "task_writer_1",
      run_id: "run_1",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "passed",
      started_at: daysAgo(1),
      ended_at: daysAgo(1),
      attempt: 1,
      parent_task_id: null
    });
    const result = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("emits an insight when a single spec is retried twice within the window", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.runs.push({
      run_id: "run_1",
      spec_id: "spec_a",
      project_id: "project_a",
      outcome: null,
      ended_at: null
    });
    for (let i = 0; i < 2; i += 1) {
      client.tasks.push({
        task_id: `task_writer_${i}`,
        run_id: "run_1",
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-5",
        status: "done",
        outcome: "failed",
        started_at: daysAgo(1),
        ended_at: daysAgo(1),
        attempt: i + 1,
        parent_task_id: null
      });
    }
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "planner.rerequested",
      payload: { rejectionReason: "checker rejected behavior X" },
      ts: daysAgo(1)
    });
    const result = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    expect(() => Insight.parse(result[0])).not.toThrow();
    const insight = result[0]!;
    expect(insight.kind).toBe("retry_hotspot");
    const retryPayload = insight.payload as Extract<typeof insight.payload, { kind: "retry_hotspot" }>;
    expect(retryPayload.kind).toBe("retry_hotspot");
    expect(retryPayload.retryCount).toBe(2);
    expect(retryPayload.rejectionSummaries[0]).toContain("checker rejected");
    expect(insight.actions).toHaveLength(2);
    expect(insight.actions[0]!.label).toMatch(/Open BDD/);
  });

  it("does not emit when attempts predate the window", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.runs.push({
      run_id: "run_1",
      spec_id: "spec_a",
      project_id: "project_a",
      outcome: null,
      ended_at: null
    });
    for (let i = 0; i < 3; i += 1) {
      client.tasks.push({
        task_id: `task_old_${i}`,
        run_id: "run_1",
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-5",
        status: "done",
        outcome: "failed",
        started_at: daysAgo(30),
        ended_at: daysAgo(30),
        attempt: i + 1,
        parent_task_id: null
      });
    }
    const result = await computeRetryHotspot(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });
});

describe("computeModelMismatch", () => {
  it("returns no insights when there is no model variance", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    for (let i = 0; i < 3; i += 1) {
      const spec = `spec_${i}`;
      client.specs.push({ spec_id: spec, title: `Spec ${i}`, project_id: "project_a" });
      client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
      const run = `run_${i}`;
      client.runs.push({
        run_id: run,
        spec_id: spec,
        project_id: "project_a",
        outcome: "merged",
        ended_at: daysAgo(2)
      });
      const task = `task_${i}`;
      client.tasks.push({
        task_id: task,
        run_id: run,
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-5",
        status: "done",
        outcome: "passed",
        started_at: daysAgo(2),
        ended_at: daysAgo(2),
        attempt: 1,
        parent_task_id: null
      });
      client.costs.push({
        task_id: task,
        run_id: run,
        cli: "codex",
        model: "gpt-5",
        cost_usd: 0.5,
        recorded_at: daysAgo(2)
      });
    }
    const result = await computeModelMismatch(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("emits a model_mismatch insight when the recent model is 2× the cheapest", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    // 3 specs merged on cheap gpt-4o at $0.20 each.
    for (let i = 0; i < 3; i += 1) {
      const spec = `spec_cheap_${i}`;
      client.specs.push({ spec_id: spec, title: spec, project_id: "project_a" });
      client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
      const run = `run_cheap_${i}`;
      client.runs.push({
        run_id: run,
        spec_id: spec,
        project_id: "project_a",
        outcome: "merged",
        ended_at: daysAgo(20)
      });
      const task = `task_cheap_${i}`;
      client.tasks.push({
        task_id: task,
        run_id: run,
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-4o",
        status: "done",
        outcome: "passed",
        started_at: daysAgo(20),
        ended_at: daysAgo(20),
        attempt: 1,
        parent_task_id: null
      });
      client.costs.push({
        task_id: task,
        run_id: run,
        cli: "codex",
        model: "gpt-4o",
        cost_usd: 0.2,
        recorded_at: daysAgo(20)
      });
    }
    // 3 specs merged on gpt-5 at $1.00 each (more recent).
    for (let i = 0; i < 3; i += 1) {
      const spec = `spec_expensive_${i}`;
      client.specs.push({ spec_id: spec, title: spec, project_id: "project_a" });
      client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
      const run = `run_expensive_${i}`;
      client.runs.push({
        run_id: run,
        spec_id: spec,
        project_id: "project_a",
        outcome: "merged",
        ended_at: daysAgo(2)
      });
      const task = `task_expensive_${i}`;
      client.tasks.push({
        task_id: task,
        run_id: run,
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-5",
        status: "done",
        outcome: "passed",
        started_at: daysAgo(2),
        ended_at: daysAgo(2),
        attempt: 1,
        parent_task_id: null
      });
      client.costs.push({
        task_id: task,
        run_id: run,
        cli: "codex",
        model: "gpt-5",
        cost_usd: 1.0,
        recorded_at: daysAgo(2)
      });
    }
    const result = await computeModelMismatch(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    const insight = result[0]!;
    expect(() => Insight.parse(insight)).not.toThrow();
    const mismatchPayload = insight.payload as Extract<typeof insight.payload, { kind: "model_mismatch" }>;
    expect(mismatchPayload.kind).toBe("model_mismatch");
    expect(mismatchPayload.currentModel).toBe("gpt-5");
    expect(mismatchPayload.alternativeModel).toBe("gpt-4o");
    expect(mismatchPayload.specClass).toBe("Auth");
    expect(insight.actions.some((action) => action.label.includes("Switch writer"))).toBe(true);
  });
});

describe("computePaceAnomaly", () => {
  it("returns no insights when no writer tasks are in flight", async () => {
    const client = new InsightsMemoryClient();
    const result = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("emits when an in-flight task is 2× slower than the class average", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    // Three completed-passed writer tasks, each 60 seconds — class avg = 60s.
    for (let i = 0; i < 3; i += 1) {
      const spec = `spec_done_${i}`;
      client.specs.push({ spec_id: spec, title: spec, project_id: "project_a" });
      client.specMilestones.push({ spec_id: spec, milestone_id: "m_1" });
      const run = `run_done_${i}`;
      client.runs.push({
        run_id: run,
        spec_id: spec,
        project_id: "project_a",
        outcome: "merged",
        ended_at: daysAgo(1)
      });
      client.tasks.push({
        task_id: `task_done_${i}`,
        run_id: run,
        agent_kind: "writer",
        cli: "codex",
        model: "gpt-5",
        status: "done",
        outcome: "passed",
        started_at: new Date(daysAgo(1).getTime() - 60_000),
        ended_at: daysAgo(1),
        attempt: 1,
        parent_task_id: null
      });
    }
    // One in-flight task started 200 seconds ago — 3.33× the class average.
    client.specs.push({ spec_id: "spec_live", title: "Live spec", project_id: "project_a" });
    client.specMilestones.push({ spec_id: "spec_live", milestone_id: "m_1" });
    client.runs.push({
      run_id: "run_live",
      spec_id: "spec_live",
      project_id: "project_a",
      outcome: null,
      ended_at: null
    });
    client.tasks.push({
      task_id: "task_live",
      run_id: "run_live",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "running",
      outcome: null,
      started_at: new Date(NOW.getTime() - 200_000),
      ended_at: null,
      attempt: 1,
      parent_task_id: "task_planner_live"
    });
    client.events.push({
      spec_id: null,
      task_id: "task_live",
      event_type: "writer.subtask.started",
      payload: { subtaskIndex: 2 },
      ts: new Date(NOW.getTime() - 200_000)
    });
    const result = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    const insight = result[0]!;
    expect(() => Insight.parse(insight)).not.toThrow();
    const pacePayload = insight.payload as Extract<typeof insight.payload, { kind: "pace_anomaly" }>;
    expect(pacePayload.kind).toBe("pace_anomaly");
    expect(pacePayload.multiplier).toBeGreaterThanOrEqual(2);
    expect(pacePayload.subtaskIndex).toBe(2);
    expect(pacePayload.specClass).toBe("Auth");
    expect(insight.actions[0]!.label).toBe("Open run");
  });

  it("does not emit when the class average has too few samples", async () => {
    const client = new InsightsMemoryClient();
    client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
    client.specs.push({ spec_id: "spec_one", title: "spec_one", project_id: "project_a" });
    client.specMilestones.push({ spec_id: "spec_one", milestone_id: "m_1" });
    client.runs.push({
      run_id: "run_one",
      spec_id: "spec_one",
      project_id: "project_a",
      outcome: "merged",
      ended_at: daysAgo(1)
    });
    client.tasks.push({
      task_id: "task_one",
      run_id: "run_one",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "passed",
      started_at: new Date(daysAgo(1).getTime() - 60_000),
      ended_at: daysAgo(1),
      attempt: 1,
      parent_task_id: null
    });
    client.specs.push({ spec_id: "spec_live", title: "spec_live", project_id: "project_a" });
    client.specMilestones.push({ spec_id: "spec_live", milestone_id: "m_1" });
    client.runs.push({
      run_id: "run_live",
      spec_id: "spec_live",
      project_id: "project_a",
      outcome: null,
      ended_at: null
    });
    client.tasks.push({
      task_id: "task_live",
      run_id: "run_live",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "running",
      outcome: null,
      started_at: new Date(NOW.getTime() - 600_000),
      ended_at: null,
      attempt: 1,
      parent_task_id: null
    });
    const result = await computePaceAnomaly(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });
});
