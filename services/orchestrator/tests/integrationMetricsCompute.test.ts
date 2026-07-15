// Integration `rebase_vs_rebuild` reducer tests. `deriveIntegrationMetrics` is
// pure over its inputs (rebase events + per-run cost/duration rows joined at read
// time), so every figure is asserted against hand-built fixture rows — no DB.
// Covers the per-`decision` buckets, the read-time cost/wall-clock JOIN by runId,
// the headline kept-alive-vs-replanned comparison, the proof-reuse count, and the
// honest-absence (`null`) shapes.

import { describe, expect, it } from "vitest";
import {
  deriveIntegrationMetrics,
  type DeriveIntegrationOptions,
  type IntegrationInputs,
} from "../src/engine/insights/integration/index.js";
import { RebaseDecisionValues } from "../src/engine/insights/integration/types.js";

const WINDOW_END = new Date("2026-05-28T00:00:00.000Z");
const WINDOW_DAYS = 30;
const WINDOW_START = new Date(WINDOW_END.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

const OPTIONS: DeriveIntegrationOptions = {
  projectId: "project_a",
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  windowDays: WINDOW_DAYS,
};

const EMPTY: IntegrationInputs = { rebases: [], costs: [], runs: [], proofReuseCount: 0 };

/** A run with `durationSeconds` wall-clock anchored at WINDOW_END. */
function runRow(runId: string, durationSeconds: number) {
  const ended = new Date(WINDOW_END);
  const started = new Date(ended.getTime() - durationSeconds * 1000);
  return { runId, startedAt: started, endedAt: ended };
}

describe("deriveIntegrationMetrics — buckets", () => {
  it("groups rebase events by decision and joins cost/wall-clock by runId", () => {
    const inputs: IntegrationInputs = {
      proofReuseCount: 0,
      rebases: [
        { runId: "r1", decision: "rebased_clean" },
        { runId: "r2", decision: "rebased_clean" },
        { runId: "r3", decision: "replanned" },
      ],
      costs: [
        { runId: "r1", totalTokens: 100, costUsd: 0.1 },
        { runId: "r2", totalTokens: 300, costUsd: 0.3 },
        { runId: "r3", totalTokens: 1000, costUsd: 1 },
      ],
      runs: [runRow("r1", 60), runRow("r2", 120), runRow("r3", 600)],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);

    expect(m.buckets.rebased_clean.count).toBe(2);
    // median(100, 300) = 200
    expect(m.buckets.rebased_clean.medianTokens).toBe(200);
    expect(m.buckets.rebased_clean.tokensSample).toBe(2);
    // median(60, 120) = 90
    expect(m.buckets.rebased_clean.medianWallClockSeconds).toBe(90);
    expect(m.buckets.rebased_clean.wallClockSample).toBe(2);

    expect(m.buckets.replanned.count).toBe(1);
    expect(m.buckets.replanned.medianTokens).toBe(1000);
    expect(m.buckets.replanned.medianWallClockSeconds).toBe(600);

    expect(m.buckets.rebased_resolved.count).toBe(0);
    expect(m.buckets.held.count).toBe(0);
    expect(m.totalRebases).toBe(3);
  });

  it("reports null medians (not zero) for a bucket whose runs have no cost rows", () => {
    const inputs: IntegrationInputs = {
      ...EMPTY,
      rebases: [{ runId: "r1", decision: "held" }],
      // no cost row, no run row for r1
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    expect(m.buckets.held.count).toBe(1);
    expect(m.buckets.held.medianTokens).toBeNull();
    expect(m.buckets.held.tokensSample).toBe(0);
    expect(m.buckets.held.medianWallClockSeconds).toBeNull();
    expect(m.buckets.held.wallClockSample).toBe(0);
  });

  it("ignores a run whose wall-clock is unfinished (ended_at null) or negative", () => {
    const inputs: IntegrationInputs = {
      ...EMPTY,
      rebases: [
        { runId: "open", decision: "rebased_clean" },
        { runId: "good", decision: "rebased_clean" },
      ],
      runs: [{ runId: "open", startedAt: WINDOW_END, endedAt: null }, runRow("good", 50)],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    // only "good" contributes a wall-clock figure
    expect(m.buckets.rebased_clean.wallClockSample).toBe(1);
    expect(m.buckets.rebased_clean.medianWallClockSeconds).toBe(50);
  });
});

describe("deriveIntegrationMetrics — rebase_vs_rebuild headline", () => {
  it("pools clean+resolved as kept-alive and proves rebase < rebuild when cheaper", () => {
    const inputs: IntegrationInputs = {
      proofReuseCount: 0,
      rebases: [
        { runId: "c1", decision: "rebased_clean" },
        { runId: "c2", decision: "rebased_resolved" },
        { runId: "p1", decision: "replanned" },
        { runId: "p2", decision: "replanned" },
      ],
      costs: [
        { runId: "c1", totalTokens: 100, costUsd: null },
        { runId: "c2", totalTokens: 200, costUsd: null },
        { runId: "p1", totalTokens: 900, costUsd: null },
        { runId: "p2", totalTokens: 1100, costUsd: null },
      ],
      runs: [],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    // kept-alive median(100, 200) = 150; replanned median(900, 1100) = 1000
    expect(m.rebaseVsRebuild.keptAliveMedianTokens).toBe(150);
    expect(m.rebaseVsRebuild.keptAliveSample).toBe(2);
    expect(m.rebaseVsRebuild.replannedMedianTokens).toBe(1000);
    expect(m.rebaseVsRebuild.replannedSample).toBe(2);
    expect(m.rebaseVsRebuild.rebaseCheaper).toBe(true);
  });

  it("rebaseCheaper is null when either side has no sample", () => {
    const inputs: IntegrationInputs = {
      ...EMPTY,
      rebases: [{ runId: "c1", decision: "rebased_clean" }],
      costs: [{ runId: "c1", totalTokens: 100, costUsd: null }],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    expect(m.rebaseVsRebuild.keptAliveMedianTokens).toBe(100);
    expect(m.rebaseVsRebuild.replannedMedianTokens).toBeNull();
    expect(m.rebaseVsRebuild.rebaseCheaper).toBeNull();
  });
});

describe("deriveIntegrationMetrics — envelope", () => {
  it("carries the proof-reuse count and a schema-valid window envelope", () => {
    const m = deriveIntegrationMetrics({ ...EMPTY, proofReuseCount: 7 }, OPTIONS);
    expect(m.proofReuseCount).toBe(7);
    expect(m.totalRebases).toBe(0);
    expect(m.projectId).toBe("project_a");
    expect(m.windowStart).toBe(WINDOW_START.toISOString());
    expect(m.windowEnd).toBe(WINDOW_END.toISOString());
    expect(m.windowDays).toBe(WINDOW_DAYS);
    expect(m.computedAt).toBe(WINDOW_END.toISOString());
    expect(m.rebaseVsRebuild.rebaseCheaper).toBeNull();
  });
});

describe("deriveIntegrationMetrics — exhaustive buckets (F4 hostile)", () => {
  it("HOSTILE: writer_rework and parked are bucketed (not lost while counting in total)", () => {
    const inputs: IntegrationInputs = {
      proofReuseCount: 0,
      rebases: [
        { runId: "c", decision: "rebased_clean" },
        { runId: "w", decision: "writer_rework" },
        { runId: "p", decision: "parked" },
        { runId: "r", decision: "replanned" },
        { runId: "h", decision: "held" },
        { runId: "v", decision: "rebased_resolved" },
      ],
      costs: [],
      runs: [],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    // Old bug: totalRebases counted them but buckets omitted writer_rework + parked.
    expect(m.buckets.writer_rework.count).toBe(1);
    expect(m.buckets.parked.count).toBe(1);
    const sum =
      m.buckets.rebased_clean.count +
      m.buckets.rebased_resolved.count +
      m.buckets.replanned.count +
      m.buckets.writer_rework.count +
      m.buckets.parked.count +
      m.buckets.held.count;
    expect(sum).toBe(m.totalRebases);
    expect(m.totalRebases).toBe(6);
  });

  it("every RebaseDecision value has an explicit public bucket key", () => {
    const m = deriveIntegrationMetrics({ ...EMPTY }, OPTIONS);
    for (const d of RebaseDecisionValues) {
      expect(m.buckets).toHaveProperty(d);
      expect(m.buckets[d].count).toBe(0);
    }
  });

  it("unknown decision payloads are excluded from denominator (not silently lost)", () => {
    const inputs: IntegrationInputs = {
      proofReuseCount: 0,
      rebases: [
        { runId: "ok", decision: "rebased_clean" },
        { runId: "bad", decision: "not_a_decision" as "rebased_clean" },
      ],
      costs: [],
      runs: [],
    };
    const m = deriveIntegrationMetrics(inputs, OPTIONS);
    expect(m.totalRebases).toBe(1);
    expect(m.buckets.rebased_clean.count).toBe(1);
  });
});
