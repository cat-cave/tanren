// Pure-reducer tests for the benchmark foundation
// (docs/roadmap/tanren-method-benchmark.md). `projectTrialScorecard`,
// `deriveCellScorecard`, and `compareCells` are pure over their inputs, so each
// is asserted against hand-built fixtures — no DB. The stats primitives
// (bootstrap CI, Mann–Whitney U) are checked for determinism + known shapes.

import { describe, expect, it } from "vitest";
import {
  type TrialProjectionInputs,
  bootstrapMedianCI,
  mannWhitneyU,
  median,
  projectTrialScorecard,
  seededRng,
} from "../src/engine/benchmark/index.js";

const SPEC_CREATED = new Date("2026-05-01T00:00:00.000Z");
const RUN_START = new Date("2026-05-01T00:10:00.000Z");
// RUN_END is +15m from start → 900s active execution.
const RUN_END = new Date("2026-05-01T00:25:00.000Z");
// MERGED is +24m from spec creation → 1440s lead time.
const MERGED = new Date("2026-05-01T00:24:00.000Z");

function baseInputs(overrides: Partial<TrialProjectionInputs> = {}): TrialProjectionInputs {
  return {
    run: {
      runId: "run_1",
      status: "done",
      outcome: null,
      startedAt: RUN_START,
      endedAt: RUN_END,
      specCreatedAt: SPEC_CREATED,
    },
    events: [],
    tasks: [],
    costs: [],
    ...overrides,
  };
}

describe("projectTrialScorecard — §2.3 field projection", () => {
  it("projects active execution + lead time from run + merge event", () => {
    const card = projectTrialScorecard(baseInputs({ events: [{ eventType: "merge.completed", ts: MERGED }] }));
    expect(card.activeExecutionSeconds).toBe(900);
    expect(card.leadTimeSeconds).toBe(1440);
    expect(card.terminalStatus).toBe("done");
    expect(card.haltReason).toBeNull();
  });

  it("counts planner reruns split by producer (gate vs auditor)", () => {
    const card = projectTrialScorecard(
      baseInputs({
        events: [
          { eventType: "planner.rerequested", ts: RUN_START, producer: "gate" },
          { eventType: "planner.rerequested", ts: RUN_START, producer: "auditor" },
          { eventType: "planner.rerequested", ts: RUN_START, producer: "auditor" },
        ],
      }),
    );
    expect(card.plannerReruns).toBe(3);
    expect(card.plannerRerunsByProducer).toEqual({ gate: 1, auditor: 2 });
  });

  it("counts gate failures, review iterations, and audited concerns", () => {
    const card = projectTrialScorecard(
      baseInputs({
        events: [
          { eventType: "gate.failed", ts: RUN_START },
          { eventType: "gate.failed", ts: RUN_START },
          { eventType: "review.changes_requested", ts: RUN_START },
          { eventType: "auditor.rejected", ts: RUN_START },
        ],
      }),
    );
    expect(card.gateFailures).toBe(2);
    expect(card.reviewIterations).toBe(1);
    expect(card.auditedConcerns).toBe(1);
  });

  it("sums tasks.attempt over write tasks only", () => {
    const card = projectTrialScorecard(
      baseInputs({
        tasks: [
          { agentKind: "writer", attempt: 3 },
          { agentKind: "writer", attempt: 2 },
          { agentKind: "planner", attempt: 5 },
        ],
      }),
    );
    expect(card.writerIterations).toBe(5);
  });

  it("sums token columns and is null-honest about cost", () => {
    const card = projectTrialScorecard(
      baseInputs({
        costs: [
          {
            inputTokens: 10,
            cachedInputTokens: 1,
            cacheCreationTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 3,
            totalTokens: 21,
            costUsd: null,
            costBasis: "unknown",
          },
          {
            inputTokens: 20,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 30,
            costUsd: 0.5,
            costBasis: "ccusage",
          },
        ],
      }),
    );
    expect(card.tokens.total).toBe(51);
    expect(card.tokens.input).toBe(30);
    // Only the priced record contributes; the null one does not zero it out.
    expect(card.costUsd).toBeCloseTo(0.5);
    expect(card.costBasisMix).toEqual({
      provider_response: 0,
      ccusage: 1,
      provider_pricing: 0,
      credits: 0,
      unknown: 1,
      unattributed: 0,
    });
  });

  it("returns null cost when every record is unpriced (honest absence)", () => {
    const card = projectTrialScorecard(
      baseInputs({
        costs: [
          {
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0,
            totalTokens: 2,
            costUsd: null,
            costBasis: "unknown",
          },
        ],
      }),
    );
    expect(card.costUsd).toBeNull();
  });

  it("surfaces halt reason and null lead time for an unmerged halted run", () => {
    const card = projectTrialScorecard(
      baseInputs({
        run: {
          runId: "run_h",
          status: "halted",
          outcome: "retry_budget_exhausted",
          startedAt: RUN_START,
          endedAt: RUN_END,
          specCreatedAt: SPEC_CREATED,
        },
      }),
    );
    expect(card.terminalStatus).toBe("halted");
    expect(card.haltReason).toBe("retry_budget_exhausted");
    expect(card.leadTimeSeconds).toBeNull();
  });

  it("carries cell/trial join + accept result through when supplied", () => {
    const card = projectTrialScorecard(baseInputs({ cellId: "cell_a", trialIndex: 3, reachedAcceptGreen: true }));
    expect(card.cellId).toBe("cell_a");
    expect(card.trialIndex).toBe(3);
    expect(card.reachedAcceptGreen).toBe(true);
  });
});

// ---- stats primitives -----------------------------------------------------

describe("stats — median + bootstrap CI + Mann–Whitney", () => {
  it("median handles odd/even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("bootstrap CI is deterministic for a fixed seed and brackets the median", () => {
    const data = [10, 12, 11, 13, 50];
    const a = bootstrapMedianCI(data, { rng: seededRng(42), iterations: 500 });
    const b = bootstrapMedianCI(data, { rng: seededRng(42), iterations: 500 });
    expect(a).toEqual(b);
    expect(a.point).toBe(12);
    expect(a.lower!).toBeLessThanOrEqual(a.point!);
    expect(a.upper!).toBeGreaterThanOrEqual(a.point!);
  });

  it("bootstrap CI on empty is all-null; on N=1 is a degenerate point", () => {
    expect(bootstrapMedianCI([])).toEqual({ point: null, lower: null, upper: null, sample: 0 });
    expect(bootstrapMedianCI([7])).toEqual({ point: 7, lower: 7, upper: 7, sample: 1 });
  });

  it("Mann–Whitney separates two clearly different samples", () => {
    const low = [1, 2, 3, 4, 5];
    const high = [10, 11, 12, 13, 14];
    const res = mannWhitneyU(low, high);
    // Full separation: every low < every high → |effect| = 1, A runs lower.
    expect(res.effectSize).toBe(-1);
    expect(res.pValue).toBeLessThan(0.05);
  });

  it("Mann–Whitney finds no effect for identical samples", () => {
    const res = mannWhitneyU([5, 5, 5], [5, 5, 5]);
    expect(res.effectSize).toBe(0);
    expect(res.pValue).toBe(1);
  });
});
