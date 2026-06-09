// compute tests for the two new workflow insights:
//   - `stuck`: derived from spec_dependencies + spec status.
//   - `review_stall`: derived from review.*/merge.completed events.
// Both use the InsightsMemoryClient fixture, mirroring insightsCompute.test.ts.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { computeReviewStall, computeStuck, Insight } from "../src/engine/insights/index.js";
import { InsightsMemoryClient } from "./helpers/insightsMemoryClient.js";

function pool(client: InsightsMemoryClient): pg.Pool {
  return client as unknown as pg.Pool;
}

const NOW = new Date("2026-05-27T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

describe("computeStuck", () => {
  it("returns no insights when there are no dependency edges", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({
      spec_id: "spec_a",
      title: "Add login",
      project_id: "project_a",
      status: "open",
    });
    const result = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("stays silent when every dependency is finished", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({
      spec_id: "spec_a",
      title: "API",
      project_id: "project_a",
      status: "merged",
    });
    client.specs.push({
      spec_id: "spec_b",
      title: "UI",
      project_id: "project_a",
      status: "in_flight",
    });
    // spec_b depends on spec_a, but spec_a is merged → not stuck.
    client.specDependencies.push({ from_spec_id: "spec_b", to_spec_id: "spec_a" });
    const result = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("emits when a spec is blocked on an unfinished dependency", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({
      spec_id: "spec_api",
      title: "Build API",
      project_id: "project_a",
      status: "in_flight",
    });
    client.specs.push({
      spec_id: "spec_ui",
      title: "Build UI",
      project_id: "project_a",
      status: "open",
    });
    // spec_ui depends on spec_api which is still in_flight.
    client.specDependencies.push({ from_spec_id: "spec_ui", to_spec_id: "spec_api" });
    const result = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    const insight = result[0]!;
    expect(() => Insight.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("stuck");
    const payload = insight.payload as Extract<typeof insight.payload, { kind: "stuck" }>;
    expect(payload.blockedSpecId).toBe("spec_ui");
    expect(payload.blockingSpecs).toHaveLength(1);
    expect(payload.blockingSpecs[0]!.specId).toBe("spec_api");
    expect(payload.chainDepth).toBe(2);
    expect(insight.actions).toHaveLength(2);
  });

  it("counts the unfinished chain depth and escalates severity", async () => {
    const client = new InsightsMemoryClient();
    // spec_c -> spec_b -> spec_a, all unfinished → chainDepth 3 from spec_c.
    client.specs.push({ spec_id: "spec_a", title: "A", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "spec_b", title: "B", project_id: "project_a", status: "open" });
    client.specs.push({ spec_id: "spec_c", title: "C", project_id: "project_a", status: "open" });
    client.specDependencies.push({ from_spec_id: "spec_c", to_spec_id: "spec_b" });
    client.specDependencies.push({ from_spec_id: "spec_b", to_spec_id: "spec_a" });
    const result = await computeStuck(pool(client), { projectId: "project_a", now: NOW });
    const head = result.find(
      (i) => (i.payload as Extract<typeof i.payload, { kind: "stuck" }>).blockedSpecId === "spec_c",
    )!;
    expect(head).toBeDefined();
    const payload = head.payload as Extract<typeof head.payload, { kind: "stuck" }>;
    expect(payload.chainDepth).toBe(3);
    expect(head.severity).toBe("warn");
  });
});

describe("computeReviewStall", () => {
  it("returns no insights without review events", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("stays silent when review is approved or merged after request", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 12, prUrl: "https://github.com/x/y/pull/12" },
      ts: hoursAgo(72),
    });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "merge.completed",
      payload: {
        prNumber: 12,
        prUrl: "https://github.com/x/y/pull/12",
        integration: "direct_merge",
      },
      ts: hoursAgo(1),
    });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("stays silent when the request is within the threshold", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 12, prUrl: "https://github.com/x/y/pull/12" },
      ts: hoursAgo(4),
    });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });

  it("emits when a review request stalls past the threshold", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 42, prUrl: "https://github.com/x/y/pull/42" },
      ts: hoursAgo(72),
    });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    const insight = result[0]!;
    expect(() => Insight.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("review_stall");
    const payload = insight.payload as Extract<typeof insight.payload, { kind: "review_stall" }>;
    expect(payload.specId).toBe("spec_a");
    expect(payload.prNumber).toBe(42);
    expect(payload.phase).toBe("awaiting_review");
    expect(payload.stalledHours).toBeGreaterThanOrEqual(72);
    expect(insight.actions).toHaveLength(2);
  });

  it("emits a changes_requested stall when that is the latest signal", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_a", title: "Add login", project_id: "project_a" });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 7, prUrl: "https://github.com/x/y/pull/7" },
      ts: hoursAgo(120),
    });
    client.events.push({
      spec_id: "spec_a",
      task_id: null,
      event_type: "review.changes_requested",
      payload: { prNumber: 7, prUrl: "https://github.com/x/y/pull/7", message: "fix tests" },
      ts: hoursAgo(96),
    });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(1);
    const payload = result[0]!.payload as Extract<(typeof result)[0]["payload"], { kind: "review_stall" }>;
    expect(payload.phase).toBe("changes_requested");
    // 96h >= 2 × 48h threshold.
    expect(result[0]!.severity).toBe("warn");
  });

  it("BOUNDS the review-event scan: the SQL carries a time window AND a LIMIT (audit §4.3)", async () => {
    // Capture the exact SQL + params the compute issues for the review-event scan.
    const captured: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
    const recordingPool = {
      query(sql: string, params: ReadonlyArray<unknown> = []) {
        captured.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as pg.Pool;

    await computeReviewStall(recordingPool, { projectId: "project_a", now: NOW });

    const review = captured.find((c) => c.sql.includes("FROM events e") && c.sql.includes("INNER JOIN specs s"));
    expect(review).toBeDefined();
    // BOTH bounds present: a time predicate on the event ts AND a row LIMIT.
    expect(review!.sql).toMatch(/e\.ts\s*>=\s*\$3/u);
    expect(review!.sql).toMatch(/LIMIT\s+10000/u);
    // The `$3` window param is a Date strictly before `now`.
    const since = review!.params[2] as Date;
    expect(since).toBeInstanceOf(Date);
    expect(since.getTime()).toBeLessThan(NOW.getTime());
  });

  it("EXCLUDES a review event older than the lookback window (time bound applied)", async () => {
    const client = new InsightsMemoryClient();
    client.specs.push({ spec_id: "spec_old", title: "Stale PR", project_id: "project_a" });
    // 60 days ago — older than the 30-day default window, so it must NOT surface
    // even though it would otherwise be a long-stalled review.requested.
    client.events.push({
      spec_id: "spec_old",
      task_id: null,
      event_type: "review.requested",
      payload: { prNumber: 99, prUrl: "https://github.com/x/y/pull/99" },
      ts: hoursAgo(60 * 24),
    });
    const result = await computeReviewStall(pool(client), { projectId: "project_a", now: NOW });
    expect(result).toHaveLength(0);
  });
});
