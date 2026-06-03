// P2e-1 queue/stack-statistics reducer tests. `deriveQueueStats` is pure over
// the native-queue events + the dependency edges, so every metric is asserted
// against hand-built fixtures — no DB. Covers depth-over-time, time-in-queue,
// batch pass-rate, bisect/culprit counts, dequeue-by-reason, and stack depth.

import { describe, expect, it } from "vitest";
import {
  deriveQueueStats,
  normalizeQueueEvent,
  type DependencyEdge,
  type QueueEvent,
  type DeriveQueueOptions,
} from "../src/engine/insights/queue/index.js";

const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(WINDOW_END.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
const OPTIONS: DeriveQueueOptions = {
  projectId: "project_a",
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  windowDays: WINDOW_DAYS,
};

function e(eventType: QueueEvent["eventType"], tsMs: number, extra: Partial<QueueEvent> = {}): QueueEvent {
  return {
    eventType,
    ts: new Date(tsMs),
    specId: extra.specId ?? null,
    queueDepth: extra.queueDepth ?? null,
    dequeueReason: extra.dequeueReason ?? null,
    bisectChecks: extra.bisectChecks ?? null,
  };
}

function derive(events: QueueEvent[], edges: DependencyEdge[] = []) {
  return deriveQueueStats({ events, dependencyEdges: edges }, OPTIONS);
}

describe("deriveQueueStats — depth over time", () => {
  it("samples depth at each merge.queue.advanced", () => {
    const stats = derive([
      e("merge.queue.advanced", 1000, { specId: "s1", queueDepth: 3 }),
      e("merge.queue.advanced", 2000, { specId: "s2", queueDepth: 2 }),
    ]);
    expect(stats.depthSeries).toHaveLength(2);
    expect(stats.maxDepth).toBe(3);
    expect(stats.meanDepth).toBeCloseTo(2.5);
  });

  it("null depth metrics with no selections", () => {
    const stats = derive([]);
    expect(stats.maxDepth).toBeNull();
    expect(stats.meanDepth).toBeNull();
  });
});

describe("deriveQueueStats — time in queue", () => {
  it("measures queued → next advanced/dequeued per spec (FIFO)", () => {
    const stats = derive([
      e("merge.queued", 0, { specId: "s1" }),
      e("merge.queued", 1000, { specId: "s2" }),
      // s1 waited 5s, s2 waited 2s
      e("merge.queue.advanced", 5000, { specId: "s1", queueDepth: 1 }),
      e("merge.dequeued", 3000, { specId: "s2", dequeueReason: "conflict" }),
    ]);
    expect(stats.timeInQueueSample).toBe(2);
    // samples: 5s (s1) and 2s (s2) → median 3.5s, max 5s
    expect(stats.medianTimeInQueueSeconds).toBeCloseTo(3.5);
    expect(stats.maxTimeInQueueSeconds).toBe(5);
  });
});

describe("deriveQueueStats — batch / bisect", () => {
  it("computes batch pass-rate and bisect/culprit counts", () => {
    const stats = derive([
      e("merge.batch.checking", 0),
      e("merge.batch.passed", 1000),
      e("merge.batch.checking", 2000),
      e("merge.batch.bisecting", 3000),
      e("merge.batch.culprit", 4000, { specId: "s9", bisectChecks: 2 }),
    ]);
    expect(stats.batchesChecked).toBe(2);
    expect(stats.batchesPassed).toBe(1);
    expect(stats.batchPassRate).toBeCloseTo(0.5);
    expect(stats.batchesBisected).toBe(1);
    expect(stats.culpritsIsolated).toBe(1);
    expect(stats.bisectChecksPerformed).toBe(2);
  });

  it("null batch pass-rate when no batches were checked", () => {
    expect(derive([]).batchPassRate).toBeNull();
  });
});

describe("deriveQueueStats — dequeues by reason", () => {
  it("tallies conflict / blocked / failed / superseded dequeues", () => {
    const stats = derive([
      e("merge.dequeued", 0, { specId: "s1", dequeueReason: "conflict" }),
      e("merge.dequeued", 1000, { specId: "s2", dequeueReason: "blocked" }),
      e("merge.dequeued", 2000, { specId: "s3", dequeueReason: "failed" }),
      e("merge.dequeued", 3000, { specId: "s4", dequeueReason: "conflict" }),
      e("merge.dequeued", 4000, { specId: "s5", dequeueReason: "superseded" }),
    ]);
    expect(stats.dequeues).toEqual({ conflict: 2, blocked: 1, failed: 1, superseded: 1 });
  });
});

describe("deriveQueueStats — stack depth (DAG-derived)", () => {
  it("measures the deepest dependency chain among queued specs", () => {
    // s1 -> s2 -> s3 (each depends on the next); all queued.
    const events = [
      e("merge.queued", 0, { specId: "s1" }),
      e("merge.queued", 1000, { specId: "s2" }),
      e("merge.queued", 2000, { specId: "s3" }),
    ];
    const edges: DependencyEdge[] = [
      { fromSpecId: "s1", toSpecId: "s2" },
      { fromSpecId: "s2", toSpecId: "s3" },
    ];
    expect(derive(events, edges).maxStackDepth).toBe(3);
  });

  it("ignores edges to specs that never entered the queue", () => {
    const events = [e("merge.queued", 0, { specId: "s1" })];
    const edges: DependencyEdge[] = [{ fromSpecId: "s1", toSpecId: "sOther" }];
    expect(derive(events, edges).maxStackDepth).toBe(1);
  });

  it("is cycle-safe (a dependency cycle does not loop forever)", () => {
    const events = [e("merge.queued", 0, { specId: "s1" }), e("merge.queued", 1000, { specId: "s2" })];
    const edges: DependencyEdge[] = [
      { fromSpecId: "s1", toSpecId: "s2" },
      { fromSpecId: "s2", toSpecId: "s1" },
    ];
    expect(derive(events, edges).maxStackDepth).toBe(2);
  });
});

describe("normalizeQueueEvent — raw row → reducer event", () => {
  it("extracts queueDepth / reason / checks / specId from payload", () => {
    expect(
      normalizeQueueEvent({
        event_type: "merge.queue.advanced",
        spec_id: "s1",
        payload: { queueDepth: 4 },
        ts: new Date(0),
      }),
    ).toMatchObject({ eventType: "merge.queue.advanced", specId: "s1", queueDepth: 4 });

    expect(
      normalizeQueueEvent({
        event_type: "merge.batch.culprit",
        spec_id: null,
        payload: { specId: "s9", checks: 3 },
        ts: new Date(0),
      }),
    ).toMatchObject({ eventType: "merge.batch.culprit", specId: "s9", bisectChecks: 3 });
  });
});
