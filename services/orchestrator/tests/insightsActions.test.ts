// P2A-0020 action-routing + multi-run end-to-end scenario.
//
// Validates:
//  - the multi-run scenario produces both retry_hotspot and model_mismatch
//    insights read through the loader / cache
//  - every insight action's `toolCall` parses against the P2A-0008
//    ForgeToolCall discriminated union (i.e. clicking the action calls a
//    real tool)
//  - the `tanren.acknowledge_insight` tool persists through to the cache
//    table so the next read no longer surfaces the insight

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ForgeToolCall } from "../src/engine/answerers/schemas/forge.js";
import { tanrenAcknowledgeInsight } from "../src/engine/forge/index.js";
import { acknowledgeInsight, loadInsightsForProject, writeInsights } from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");
const ACTOR: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["org:member", "project:member"],
  source: "session",
};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function seedMultiRun(client: InsightsMemoryClient): void {
  client.milestones.push({ id: "m_1", project_id: "project_a", label: "Auth" });
  // Spec X is retried twice with gpt-5 inside the 7-day window.
  client.specs.push({ spec_id: "spec_x", title: "Add SSO", project_id: "project_a" });
  client.specMilestones.push({ spec_id: "spec_x", milestone_id: "m_1" });
  client.runs.push({
    run_id: "run_x",
    spec_id: "spec_x",
    project_id: "project_a",
    outcome: null,
    ended_at: null,
  });
  for (let i = 0; i < 2; i += 1) {
    client.tasks.push({
      task_id: `task_x_${i}`,
      run_id: "run_x",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "failed",
      started_at: daysAgo(1),
      ended_at: daysAgo(1),
      attempt: i + 1,
      parent_task_id: null,
    });
  }
  client.events.push({
    spec_id: "spec_x",
    task_id: null,
    event_type: "planner.rerequested",
    payload: { rejectionReason: "auditor rejected behavior Y" },
    ts: daysAgo(1),
  });
  // 3 specs merged on cheap gpt-4o ($0.20 each).
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
      ended_at: daysAgo(20),
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
      parent_task_id: null,
    });
    client.costs.push({
      task_id: task,
      run_id: run,
      cli: "codex",
      model: "gpt-4o",
      cost_usd: 0.2,
      recorded_at: daysAgo(20),
    });
  }
  // 3 specs merged on expensive gpt-5 ($1.00 each, more recent).
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
      ended_at: daysAgo(2),
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
      parent_task_id: null,
    });
    client.costs.push({
      task_id: task,
      run_id: run,
      cli: "codex",
      model: "gpt-5",
      cost_usd: 1.0,
      recorded_at: daysAgo(2),
    });
  }
}

describe("multi-run scenario", () => {
  it("produces retry_hotspot AND model_mismatch insights through the loader", async () => {
    const client = new InsightsMemoryClient();
    seedMultiRun(client);
    const insights = await loadInsightsForProject(pool(client), {
      projectId: "project_a",
      now: NOW,
    });
    const kinds = insights.map((entry) => entry.kind).sort();
    expect(kinds).toContain("retry_hotspot");
    expect(kinds).toContain("model_mismatch");
  });

  it("every insight action's toolCall parses as a real ForgeToolCall", async () => {
    const client = new InsightsMemoryClient();
    seedMultiRun(client);
    const insights = await loadInsightsForProject(pool(client), {
      projectId: "project_a",
      now: NOW,
    });
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      for (const action of insight.actions) {
        const parsed = ForgeToolCall.safeParse(action.toolCall);
        expect(parsed.success).toBe(true);
      }
    }
  });
});

describe("acknowledge action routing", () => {
  it("the tanrenAcknowledgeInsight tool persists to the workflow_insights cache", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [
      {
        id: "insight_route_1",
        kind: "retry_hotspot",
        projectId: "project_a",
        severity: "info",
        title: "T",
        body: "B",
        payload: {
          kind: "retry_hotspot",
          specId: "spec_x",
          specTitle: "Add SSO",
          writerCli: "codex",
          writerModel: "gpt-5",
          retryCount: 2,
          windowDays: 7,
          rejectionSummaries: [],
        },
        actions: [
          {
            label: "Ack",
            toolCall: {
              tool: "tanren.acknowledge_insight",
              args: { insightId: "insight_route_1" },
            },
          },
        ],
        computedAt: NOW,
        acknowledgedAt: null,
        acknowledgedBy: null,
      },
    ]);

    const result = await tanrenAcknowledgeInsight({ pool: pool(client) }, { insightId: "insight_route_1" }, ACTOR);
    expect(result.insightId).toBe("insight_route_1");
    expect(result.persisted).toBe(true);
    const acked = await acknowledgeInsight(pool(client), "insight_route_1", ACTOR.userId, NOW);
    expect(acked).toBe(false); // already acked
  });
});
