// read-through cache tests.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeInsight,
  loadInsightsForProject,
  readFreshOrCompute,
  writeInsights,
  type Insight,
} from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");

function syntheticInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: "insight_test_1",
    kind: "retry_hotspot",
    projectId: "project_a",
    severity: "info",
    title: "Test insight",
    body: "Synthetic body",
    payload: {
      kind: "retry_hotspot",
      specId: "spec_a",
      specTitle: "Spec A",
      writerCli: "codex",
      writerModel: "gpt-5",
      retryCount: 2,
      windowDays: 7,
      rejectionSummaries: ["reason"],
    },
    actions: [
      {
        label: "Ack",
        toolCall: { tool: "tanren.acknowledge_insight", args: { insightId: "insight_test_1" } },
      },
    ],
    computedAt: NOW,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  } as Insight;
}

describe("readFreshOrCompute", () => {
  it("invokes compute() on a cold cache and writes the result", async () => {
    const client = new InsightsMemoryClient();
    const compute = vi.fn<() => Promise<Insight[]>>(async () => [syntheticInsight()]);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: NOW,
      compute,
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("compute");
    expect(result.insights).toHaveLength(1);
    expect(client.insights).toHaveLength(1);
  });

  it("returns cached rows without recomputing when the cache is fresh", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [syntheticInsight()]);
    const compute = vi.fn<() => Promise<Insight[]>>(async () => [syntheticInsight()]);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: new Date(NOW.getTime() + 30 * 60 * 1000),
      compute,
    });
    expect(compute).not.toHaveBeenCalled();
    expect(result.source).toBe("cache");
    expect(result.insights).toHaveLength(1);
  });

  it("recomputes when the cache row is older than cacheFreshnessMs", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [syntheticInsight()]);
    const compute = vi.fn<() => Promise<Insight[]>>(async () => [syntheticInsight({ id: "insight_test_2" })]);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
      compute,
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("compute");
    expect(result.insights.some((entry) => entry.id === "insight_test_2")).toBe(true);
  });

  it("filters out acknowledged rows even when fresh", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [syntheticInsight()]);
    const acked = await acknowledgeInsight(pool(client), "insight_test_1", "user_x", NOW);
    expect(acked).toBe(true);
    const compute = vi.fn<() => Promise<Insight[]>>(async () => []);
    const result = await readFreshOrCompute(pool(client), {
      projectId: "project_a",
      kind: "retry_hotspot",
      now: new Date(NOW.getTime() + 30 * 60 * 1000),
      compute,
    });
    expect(result.source).toBe("compute");
  });
});

describe("loadInsightsForProject", () => {
  it("returns an empty list against Phase 1 fixture-shaped data (no retries, no model variance, no slow tasks)", async () => {
    // The fixture's clean shape: one merged run, no retries, single model.
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.runs.push({
      run_id: "run_1",
      spec_id: "spec_a",
      project_id: "project_a",
      outcome: "merged",
      ended_at: NOW,
    });
    client.tasks.push({
      task_id: "task_1",
      run_id: "run_1",
      agent_kind: "writer",
      cli: "codex",
      model: "gpt-5",
      status: "done",
      outcome: "passed",
      started_at: NOW,
      ended_at: NOW,
      attempt: 1,
      parent_task_id: null,
    });
    const insights = await loadInsightsForProject(pool(client), {
      projectId: "project_a",
      now: NOW,
    });
    expect(insights).toEqual([]);
  });
});

describe("acknowledgeInsight", () => {
  it("flips the row and returns true once, then false on re-ack", async () => {
    const client = new InsightsMemoryClient();
    await writeInsights(pool(client), [syntheticInsight()]);
    expect(await acknowledgeInsight(pool(client), "insight_test_1", "user_a", NOW)).toBe(true);
    expect(await acknowledgeInsight(pool(client), "insight_test_1", "user_a", NOW)).toBe(false);
  });
});
