// P3-0018 subscription-window heatmap aggregation unit tests. Exercises the
// 30-day × 5-window fill matrix + per-window avg-fill derived from existing
// P2A-0011 cost records (billingMode === "subscription"). Pure functions — no
// I/O, no new data collection.

import { describe, expect, it } from "vitest";
import type { CostRecord } from "../src/api/types.js";
import { buildHeatmap, underfilledWindows, HEATMAP_DAYS, WINDOW_COUNT } from "../src/components/costs/heatmap.js";

function rec(over: Partial<CostRecord>): CostRecord {
  return {
    id: Math.random(),
    runId: "run_1",
    taskId: "task_1",
    projectId: "proj_1",
    cli: "codex",
    provider: "openai",
    model: "gpt-5.5",
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 0,
    totalTokens: 1500,
    costUsd: null,
    billingMode: "subscription",
    costBasis: "unknown",
    recordedAt: "2026-05-28T12:00:00.000Z",
    ...over,
  };
}

const NOW = new Date("2026-05-28T23:59:59.000Z");

describe("buildHeatmap — shape", () => {
  it("always returns a 5-window × 30-day grid, even when empty", () => {
    const matrix = buildHeatmap([], { now: NOW });
    expect(matrix.rows).toHaveLength(WINDOW_COUNT);
    for (const row of matrix.rows) {
      expect(row.cells).toHaveLength(HEATMAP_DAYS);
      expect(row.avgFill).toBe(0);
    }
    expect(matrix.dayKeys).toHaveLength(HEATMAP_DAYS);
    expect(matrix.empty).toBe(true);
    expect(matrix.records).toBe(0);
  });

  it("labels day columns oldest → newest with today last", () => {
    const matrix = buildHeatmap([], { now: NOW });
    expect(matrix.dayKeys[HEATMAP_DAYS - 1]).toBe("2026-05-28");
    // 30-day window ending today → first column is 29 days earlier.
    expect(matrix.dayKeys[0]).toBe("2026-04-29");
  });
});

describe("buildHeatmap — only subscription records, bucketed by window", () => {
  it("ignores non-subscription billing modes", () => {
    const matrix = buildHeatmap(
      [
        rec({ billingMode: "per_token", costUsd: "5.00", recordedAt: "2026-05-28T12:00:00.000Z" }),
        rec({ billingMode: "self_hosted", recordedAt: "2026-05-28T12:00:00.000Z" }),
      ],
      { now: NOW },
    );
    expect(matrix.empty).toBe(true);
    expect(matrix.totalTokens).toBe(0);
  });

  it("buckets a record into its 5-hour UTC window + correct day column", () => {
    // 02:00 UTC → night (row 0); 12:00 UTC → midday (row 2); 22:00 → evening (row 4).
    const matrix = buildHeatmap(
      [
        rec({ recordedAt: "2026-05-28T02:00:00.000Z", totalTokens: 100 }),
        rec({ recordedAt: "2026-05-28T12:00:00.000Z", totalTokens: 400 }),
        rec({ recordedAt: "2026-05-28T22:00:00.000Z", totalTokens: 200 }),
      ],
      { now: NOW },
    );
    const last = HEATMAP_DAYS - 1;
    expect(matrix.rows[0]?.cells[last]?.tokens).toBe(100); // night
    expect(matrix.rows[2]?.cells[last]?.tokens).toBe(400); // midday
    expect(matrix.rows[4]?.cells[last]?.tokens).toBe(200); // evening
    expect(matrix.records).toBe(3);
    expect(matrix.totalTokens).toBe(700);
  });

  it("drops records older than the 30-day window", () => {
    const matrix = buildHeatmap([rec({ recordedAt: "2026-01-01T12:00:00.000Z", totalTokens: 999 })], { now: NOW });
    expect(matrix.empty).toBe(true);
  });

  it("sums multiple records that land in the same cell", () => {
    const matrix = buildHeatmap(
      [
        rec({ recordedAt: "2026-05-28T12:00:00.000Z", totalTokens: 100 }),
        rec({ recordedAt: "2026-05-28T13:00:00.000Z", totalTokens: 150 }),
      ],
      { now: NOW },
    );
    expect(matrix.rows[2]?.cells[HEATMAP_DAYS - 1]?.tokens).toBe(250);
  });
});

describe("buildHeatmap — fill normalization + avg-fill", () => {
  it("normalizes fill against the busiest cell (peak → 1.0)", () => {
    const matrix = buildHeatmap(
      [
        rec({ recordedAt: "2026-05-28T12:00:00.000Z", totalTokens: 1000 }), // peak (midday)
        rec({ recordedAt: "2026-05-28T02:00:00.000Z", totalTokens: 250 }), // night = 1/4 fill
      ],
      { now: NOW },
    );
    expect(matrix.peakCellTokens).toBe(1000);
    const last = HEATMAP_DAYS - 1;
    expect(matrix.rows[2]?.cells[last]?.fill).toBeCloseTo(1);
    expect(matrix.rows[0]?.cells[last]?.fill).toBeCloseTo(0.25);
  });

  it("computes per-window avg-fill across the 30 day-cells", () => {
    // One full-peak midday cell → that window's avg = 1/30 of the grid.
    const matrix = buildHeatmap([rec({ recordedAt: "2026-05-28T12:00:00.000Z", totalTokens: 1000 })], { now: NOW });
    expect(matrix.rows[2]?.avgFill).toBeCloseTo(1 / HEATMAP_DAYS);
    // Untouched windows average 0.
    expect(matrix.rows[0]?.avgFill).toBe(0);
  });
});

describe("underfilledWindows", () => {
  it("flags windows below the 30% avg-fill threshold", () => {
    // Fill midday hard across many days so its avg clears 30%, leave night dark.
    const records: CostRecord[] = [];
    for (let d = 0; d < HEATMAP_DAYS; d += 1) {
      const day = new Date(NOW);
      day.setUTCDate(day.getUTCDate() - d);
      const key = day.toISOString().slice(0, 10);
      records.push(rec({ recordedAt: `${key}T12:00:00.000Z`, totalTokens: 1000 }));
    }
    // One small night blip so night has some non-zero but tiny avg.
    records.push(rec({ recordedAt: "2026-05-28T02:00:00.000Z", totalTokens: 10 }));
    const matrix = buildHeatmap(records, { now: NOW });
    const low = underfilledWindows(matrix);
    const lowSubs = low.map((r) => r.sub);
    expect(lowSubs).toContain("night");
    expect(lowSubs).not.toContain("midday");
  });
});
