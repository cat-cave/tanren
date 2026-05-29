// P2B-0005 cost-aggregation unit tests. Exercises the three pricing models
// (per_token / subscription / self_hosted), real-source reconciliation (every
// row carries its REAL cost_basis; no fabricated unknown-source placeholder),
// burn projection, and observed metrics. Pure functions — no I/O.

import { describe, expect, it } from "vitest";
import type { CostRecord } from "../src/api/types.js";
import {
  observeMetrics,
  projectBurn,
  summarizeCosts,
  PRICING_MODELS,
  COST_BASIS_META,
} from "../src/components/costs/aggregate.js";

function rec(over: Partial<CostRecord>): CostRecord {
  return {
    id: Math.random(),
    runId: "run_1",
    taskId: "task_1",
    projectId: "proj_1",
    cli: "claude",
    provider: "anthropic",
    model: "opus-4.7",
    inputTokens: 1000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 500,
    reasoningOutputTokens: 0,
    totalTokens: 1500,
    costUsd: "1.000000",
    billingMode: "per_token",
    costBasis: "provider_pricing",
    recordedAt: "2026-05-28T12:00:00.000Z",
    ...over,
  };
}

describe("summarizeCosts — three pricing models", () => {
  it("rolls each billingMode into its own model bucket (all three always present)", () => {
    const records: CostRecord[] = [
      rec({
        runId: "r1",
        billingMode: "per_token",
        costBasis: "provider_pricing",
        costUsd: "10.00",
      }),
      rec({
        runId: "r2",
        billingMode: "subscription",
        costBasis: "unknown",
        costUsd: null,
        provider: "openai",
        cli: "codex",
      }),
      rec({
        runId: "r3",
        billingMode: "self_hosted",
        costBasis: "unknown",
        costUsd: null,
        provider: "qwen",
        cli: "opencode",
      }),
    ];
    const summary = summarizeCosts(records);
    expect(summary.models.map((m) => m.mode)).toEqual([...PRICING_MODELS]);
    const perToken = summary.models.find((m) => m.mode === "per_token");
    const subscription = summary.models.find((m) => m.mode === "subscription");
    const selfHosted = summary.models.find((m) => m.mode === "self_hosted");
    expect(perToken?.costUsd).toBeCloseTo(10);
    // Subscription / self-hosted have no per-call dollar basis → $0 priced,
    // but their token volume is still tracked (use-it-or-lose-it headroom).
    expect(subscription?.costUsd).toBe(0);
    expect(subscription?.totalTokens).toBe(1500);
    expect(selfHosted?.costUsd).toBe(0);
    expect(selfHosted?.records).toBe(1);
  });

  it("computes per-model share against priced total", () => {
    const records: CostRecord[] = [
      rec({ runId: "r1", billingMode: "per_token", costUsd: "75.00" }),
      rec({ runId: "r2", billingMode: "per_token", costUsd: "25.00", costBasis: "ccusage" }),
    ];
    const summary = summarizeCosts(records);
    expect(summary.totalUsd).toBeCloseTo(100);
    const perToken = summary.models.find((m) => m.mode === "per_token");
    expect(perToken?.share).toBeCloseTo(1);
  });
});

describe("summarizeCosts — every row shows its REAL source", () => {
  it("keeps distinct cost-basis rows separate and labels each real source", () => {
    const records: CostRecord[] = [
      rec({ runId: "r1", costBasis: "provider_pricing", costUsd: "5.00" }),
      rec({ runId: "r1", costBasis: "ccusage", costUsd: "3.00" }),
      rec({
        runId: "r2",
        billingMode: "subscription",
        costBasis: "unknown",
        costUsd: null,
        provider: "openai",
        cli: "codex",
        model: "gpt-5.5",
      }),
    ];
    const summary = summarizeCosts(records);
    // provider_pricing and ccusage for the same triple are NOT merged — the
    // source dot must be unambiguous.
    const bases = summary.providers.map((p) => p.costBasis);
    expect(bases).toContain("provider_pricing");
    expect(bases).toContain("ccusage");
    expect(bases).toContain("unknown");
    // No row invents a dollar figure for an unknown basis.
    const unknownRow = summary.providers.find((p) => p.costBasis === "unknown");
    expect(unknownRow?.priced).toBe(false);
    expect(unknownRow?.costUsd).toBe(0);
    // The unknown basis is honestly labelled, not a fabricated placeholder.
    expect(COST_BASIS_META.unknown.label).toMatch(/tokens only/);
  });

  it("counts unpriced records honestly", () => {
    const records: CostRecord[] = [
      rec({ costUsd: "1.00" }),
      rec({ costUsd: null, billingMode: "subscription", costBasis: "unknown" }),
    ];
    const summary = summarizeCosts(records);
    expect(summary.unpricedRecords).toBe(1);
  });

  it("sorts provider rows by dollars desc", () => {
    const records: CostRecord[] = [
      rec({ runId: "a", model: "haiku", costUsd: "2.00" }),
      rec({ runId: "b", model: "opus", costUsd: "40.00" }),
      rec({ runId: "c", model: "sonnet", costUsd: "12.00" }),
    ];
    const summary = summarizeCosts(records);
    expect(summary.providers[0]?.model).toBe("opus");
    expect(summary.providers[summary.providers.length - 1]?.model).toBe("haiku");
  });
});

describe("projectBurn", () => {
  it("buckets priced spend by UTC day and projects linearly", () => {
    const now = new Date("2026-05-28T00:00:00.000Z");
    const records: CostRecord[] = [
      rec({ recordedAt: "2026-05-28T10:00:00.000Z", costUsd: "2.00" }),
      rec({ recordedAt: "2026-05-27T10:00:00.000Z", costUsd: "4.00" }),
      // Unpriced records contribute nothing to burn.
      rec({
        recordedAt: "2026-05-26T10:00:00.000Z",
        costUsd: null,
        billingMode: "subscription",
        costBasis: "unknown",
      }),
    ];
    const burn = projectBurn(records, { now, windowDays: 14 });
    expect(burn.daily).toHaveLength(14);
    const total = burn.daily.reduce((s, d) => s + d.usd, 0);
    expect(total).toBeCloseTo(6);
    expect(burn.dailyAvgUsd).toBeCloseTo(6 / 14);
    expect(burn.activeDays).toBe(2);
    expect(burn.projected30dUsd).toBeCloseTo(Math.round((6 / 14) * 30 * 100) / 100);
  });
});

describe("observeMetrics", () => {
  it("derives merged count, halt-rate, and avg cost per merged from outcomes", () => {
    const runs = [
      { outcome: "phase2_easy_complete" },
      { outcome: "phase2_medium_complete" },
      { outcome: "halted" },
      { outcome: null },
    ];
    const metrics = observeMetrics(runs, 20);
    expect(metrics.specsMerged).toBe(2);
    expect(metrics.haltRate).toBeCloseTo(0.25);
    expect(metrics.avgCostPerMergedUsd).toBeCloseTo(10);
    expect(metrics.totalRuns).toBe(4);
  });

  it("returns null avg-cost when nothing merged", () => {
    const metrics = observeMetrics([{ outcome: "halted" }], 5);
    expect(metrics.avgCostPerMergedUsd).toBeNull();
  });
});
