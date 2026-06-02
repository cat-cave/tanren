// Cell-aggregation + comparison reducer tests
// (docs/roadmap/tanren-method-benchmark.md §3.2, §3.3). `deriveCellScorecard`
// and `compareCells` are pure over hand-built TrialScorecards — no DB. Covers
// median+CI per metric, the "too wide to call" flag, the merge-success/accept
// proportions, the comparison verdict directions, and the one-knob refusal.

import { describe, expect, it } from "vitest";
import {
  type TrialScorecard,
  OneKnobViolationError,
  compareCells,
  deriveCellScorecard,
  differingKnobs,
} from "../src/engine/benchmark/index.js";

// A TrialScorecard built from a few load-bearing fields; the rest default to
// zero/null so a test can vary one metric at a time. `totalTokens` is a
// convenience that threads into the nested `tokens.total` the reducer reads.
function trial(over: Partial<TrialScorecard> & { runId: string; totalTokens?: number }): TrialScorecard {
  const { totalTokens, ...rest } = over;
  return {
    cellId: "cell",
    trialIndex: 0,
    reachedAcceptGreen: null,
    terminalStatus: "done",
    haltReason: null,
    leadTimeSeconds: null,
    activeExecutionSeconds: null,
    plannerReruns: 0,
    plannerRerunsByProducer: { gate: 0, auditor: 0 },
    writerIterations: 0,
    gateFailures: 0,
    reviewIterations: 0,
    auditedConcerns: 0,
    tokens: {
      input: 0,
      cachedInput: 0,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
      total: totalTokens ?? 0,
    },
    costUsd: null,
    costBasisMix: { ccusage: 0, provider_pricing: 0, credits: 0, unknown: 0 },
    ...rest,
  };
}

describe("deriveCellScorecard — §3.2 median + CI", () => {
  it("computes the per-metric median over a cell's trials", () => {
    const trials = [
      trial({ runId: "r1", leadTimeSeconds: 100 }),
      trial({ runId: "r2", leadTimeSeconds: 200 }),
      trial({ runId: "r3", leadTimeSeconds: 300 }),
    ];
    const cell = deriveCellScorecard(trials);
    expect(cell.trials).toBe(3);
    expect(cell.metrics["leadTimeSeconds"]!.point).toBe(200);
    expect(cell.metrics["leadTimeSeconds"]!.sample).toBe(3);
  });

  it("drops null-metric trials from that metric's sample but keeps the trial", () => {
    const trials = [
      trial({ runId: "r1", leadTimeSeconds: 100, plannerReruns: 1 }),
      // The second trial is unmerged → no lead time, but still a counted trial.
      trial({ runId: "r2", leadTimeSeconds: null, plannerReruns: 2 }),
    ];
    const cell = deriveCellScorecard(trials);
    expect(cell.metrics["leadTimeSeconds"]!.sample).toBe(1);
    expect(cell.metrics["plannerReruns"]!.sample).toBe(2);
    expect(cell.trials).toBe(2);
  });

  it("flags 'too wide to call' when dispersion swamps the point", () => {
    const trials = [
      trial({ runId: "r1", leadTimeSeconds: 1 }),
      trial({ runId: "r2", leadTimeSeconds: 1000 }),
      trial({ runId: "r3", leadTimeSeconds: 5 }),
      trial({ runId: "r4", leadTimeSeconds: 2000 }),
    ];
    const cell = deriveCellScorecard(trials, { tooWideRatio: 0.5 });
    expect(cell.metrics["leadTimeSeconds"]!.tooWideToCall).toBe(true);
  });

  it("does not flag a tight, callable metric", () => {
    const trials = [
      trial({ runId: "r1", writerIterations: 3 }),
      trial({ runId: "r2", writerIterations: 3 }),
      trial({ runId: "r3", writerIterations: 3 }),
    ];
    const cell = deriveCellScorecard(trials);
    expect(cell.metrics["writerIterations"]!.tooWideToCall).toBe(false);
  });

  it("computes merge-success and accept-green proportions honestly", () => {
    const trials = [
      trial({ runId: "r1", terminalStatus: "done", reachedAcceptGreen: true }),
      trial({ runId: "r2", terminalStatus: "halted", reachedAcceptGreen: null }),
      trial({ runId: "r3", terminalStatus: "done", reachedAcceptGreen: false }),
    ];
    const cell = deriveCellScorecard(trials);
    expect(cell.mergeSuccessRate).toBeCloseTo(2 / 3);
    // Only the 2 evaluated trials count; 1 of 2 green.
    expect(cell.acceptGreenRate).toBeCloseTo(0.5);
  });

  it("reports null proportions for an empty cell", () => {
    const cell = deriveCellScorecard([]);
    expect(cell.trials).toBe(0);
    expect(cell.mergeSuccessRate).toBeNull();
    expect(cell.acceptGreenRate).toBeNull();
  });
});

describe("compareCells — §3.2 verdict", () => {
  const lowCost = [10, 11, 12, 10, 11].map((c, i) => trial({ runId: `a${i}`, totalTokens: c }));
  const highCost = [100, 101, 99, 102, 100].map((c, i) => trial({ runId: `b${i}`, totalTokens: c }));

  it("calls cell A the winner on a lower-is-better metric where A is lower", () => {
    const cmp = compareCells(lowCost, highCost);
    const tokens = cmp.metrics["totalTokens"]!;
    expect(tokens.diffOfMedians!).toBeLessThan(0);
    expect(tokens.verdict).toBe("winner_a");
  });

  it("calls cell B the winner when B is the lower one", () => {
    const cmp = compareCells(highCost, lowCost);
    expect(cmp.metrics["totalTokens"]!.verdict).toBe("winner_b");
  });

  it("returns no_call when the two samples are statistically indistinguishable", () => {
    const a = [10, 11, 12].map((c, i) => trial({ runId: `a${i}`, totalTokens: c }));
    const b = [10, 11, 12].map((c, i) => trial({ runId: `b${i}`, totalTokens: c }));
    expect(compareCells(a, b).metrics["totalTokens"]!.verdict).toBe("no_call");
  });

  it("returns no_call for a metric with no comparable sample", () => {
    const a = [trial({ runId: "a", leadTimeSeconds: null })];
    const b = [trial({ runId: "b", leadTimeSeconds: null })];
    const cmp = compareCells(a, b);
    expect(cmp.metrics["leadTimeSeconds"]!.diffOfMedians).toBeNull();
    expect(cmp.metrics["leadTimeSeconds"]!.verdict).toBe("no_call");
  });
});

describe("compareCells — §3.3 one-knob invariant", () => {
  const baseConfig = {
    routing: { write: "premium" },
    escapeHatches: { maxWriterIterPerSubtask: 5 },
    ciTiers: { fast: ["lint"] },
    governance: "strict",
    mergeIntegration: "native_queue",
  };

  it("permits a comparison when exactly one dimension differs", () => {
    const configB = { ...baseConfig, ciTiers: { fast: ["lint", "typecheck"] } };
    expect(differingKnobs(baseConfig, configB)).toEqual(["ciTiers"]);
    expect(() =>
      compareCells([trial({ runId: "a" })], [trial({ runId: "b" })], {
        configA: baseConfig,
        configB,
      }),
    ).not.toThrow();
  });

  it("refuses a comparison when more than one dimension differs", () => {
    const configB = {
      ...baseConfig,
      ciTiers: { fast: ["lint", "typecheck"] },
      routing: { write: "cheap" },
    };
    expect(differingKnobs(baseConfig, configB).sort()).toEqual(["ciTiers", "routing"]);
    expect(() =>
      compareCells([trial({ runId: "a" })], [trial({ runId: "b" })], {
        configA: baseConfig,
        configB,
      }),
    ).toThrow(OneKnobViolationError);
  });

  it("identical configs differ in zero knobs (a degenerate but allowed compare)", () => {
    expect(differingKnobs(baseConfig, { ...baseConfig })).toEqual([]);
  });
});
