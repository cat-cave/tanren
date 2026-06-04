// Unit tests for the BenchmarkRunner scheduler
// (docs/roadmap/tanren-method-benchmark.md §4.2 item 2). They drive
// `runCellTrials` with a fabricated cell + injected seams (no DB, no live
// runner) and assert the ORCHESTRATION + plumbing:
//   - it enqueues N trials, one per `trials_target`, with the cell's frozen
//     config applied to each provisioned trial;
//   - trials are SPACED + serialized (the spacing seam fires between trials, in
//     order, never before the first);
//   - a trial's terminal run is projected and an experiment_trials row written;
//   - a merged trial runs the accept step → its result + `reachedAcceptGreen`
//     flow onto the trial row; a non-merged trial skips accept (null result);
//   - `projectConfigFromFrozen` maps the frozen dimensions onto a valid V1 config.
import { describe, expect, it } from "vitest";
import { FrozenConfig } from "../src/engine/benchmark/entities.js";
import { projectConfigFromFrozen, runCellTrials } from "../src/engine/benchmark/runner.js";
import type { BenchmarkRunnerDeps, CellWithExperiment } from "../src/engine/benchmark/index.js";
import type { TrialScorecard } from "../src/engine/benchmark/scorecard.js";

const ORG = "org_bench";

function frozen(model: string): FrozenConfig {
  return FrozenConfig.parse({
    routing: { write: { chain: [{ cli: "codex", model, authRef: "credential/codex/org/x" }] } },
    escapeHatches: {},
    ciTiers: {
      tiers: { fast: [{ name: "lint", run: "pnpm lint" }], slow: [{ name: "test", run: "pnpm test" }] },
      when: { fast: ["per_iteration"], slow: ["pre_audit", "pre_merge"] },
    },
    governance: "strict",
    mergeIntegration: "not_configured",
  });
}

function fakeCell(trialsTarget: number, model = "premium"): CellWithExperiment {
  const fc = frozen(model);
  return {
    cell: { cellId: "cell_1", experimentId: "exp_1", label: "control", frozenConfig: fc, trialsTarget },
    experiment: {
      experimentId: "exp_1",
      orgId: ORG,
      title: "gate strictness",
      knob: "gate_strictness",
      hypothesis: "stricter gate lowers CFR",
      seedTaskRef: { repo: "cat-cave/tanren-fixture-medium", sha: "abcdef1234", acceptTierHash: "h", corpusTier: 1 },
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    },
    frozenConfig: fc,
    seedTaskRef: { repo: "cat-cave/tanren-fixture-medium", sha: "abcdef1234", acceptTierHash: "h", corpusTier: 1 },
  };
}

function scorecard(runId: string, reachedAcceptGreen: boolean | null): TrialScorecard {
  return {
    runId,
    cellId: "cell_1",
    trialIndex: 0,
    reachedAcceptGreen,
    terminalStatus: "done",
    haltReason: null,
    leadTimeSeconds: 100,
    activeExecutionSeconds: 50,
    plannerReruns: 0,
    plannerRerunsByProducer: { gate: 0, auditor: 0 },
    writerIterations: 1,
    gateFailures: 0,
    reviewIterations: 0,
    auditedConcerns: 0,
    tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, reasoning: 0, total: 0 },
    costUsd: null,
    costBasisMix: { provider_response: 0, ccusage: 0, provider_pricing: 0, credits: 0, unknown: 0, unattributed: 0 },
  };
}

interface Capture {
  provisioned: number[];
  spacedBefore: number[];
  accepted: number[];
  persisted: Array<{
    trialIndex: number;
    runId: string;
    acceptResult: string | null;
    reachedAcceptGreen: boolean | null;
  }>;
}

interface DepsOpts {
  merged: boolean;
  accept?: "passed" | "failed";
  terminate?: boolean;
}

function deps(cell: CellWithExperiment, opts?: DepsOpts): { deps: BenchmarkRunnerDeps; cap: Capture } {
  const resolved: DepsOpts = opts ?? { merged: true };
  const cap: Capture = { provisioned: [], spacedBefore: [], accepted: [], persisted: [] };
  const terminate = resolved.terminate ?? true;
  const d: BenchmarkRunnerDeps = {
    pool: {} as never,
    provisionTrial: async ({ trialIndex }) => {
      cap.provisioned.push(trialIndex);
      return { runId: `run_${trialIndex}`, taskId: `task_${trialIndex}` };
    },
    awaitTerminal: async () => (terminate ? { status: "done", outcome: "ok", merged: resolved.merged } : undefined),
    runAccept: async ({ trialIndex }) => {
      cap.accepted.push(trialIndex);
      return resolved.accept ?? "passed";
    },
    loadScorecard: async ({ runId, reachedAcceptGreen }) => scorecard(runId, reachedAcceptGreen),
    persistTrial: async ({ trialIndex, runId, acceptResult, scorecard: sc }) => {
      cap.persisted.push({ trialIndex, runId, acceptResult, reachedAcceptGreen: sc.reachedAcceptGreen });
    },
    spaceBeforeNextTrial: async ({ nextTrialIndex }) => {
      cap.spacedBefore.push(nextTrialIndex);
    },
  };
  return { deps: d, cap };
}

describe("BenchmarkRunner — runCellTrials", () => {
  it("enqueues exactly trials_target trials, in order, one at a time", async () => {
    const cell = fakeCell(3);
    const { deps: d, cap } = deps(cell);
    const result = await runCellTrials(d, ORG, cell);

    expect(cap.provisioned).toEqual([0, 1, 2]);
    expect(result.trials).toHaveLength(3);
    expect(result.trialsTarget).toBe(3);
    expect(result.trials.every((t) => t.runId.startsWith("run_"))).toBe(true);
  });

  it("spaces/serializes trials: the spacing seam fires before every trial after the first", async () => {
    const cell = fakeCell(3);
    const { deps: d, cap } = deps(cell);
    await runCellTrials(d, ORG, cell);
    // Trial 0 runs immediately (no gap); trials 1 and 2 are spaced before they
    // start — proving the comparability-invariant serialization (§3.3).
    expect(cap.spacedBefore).toEqual([1, 2]);
  });

  it("projects a terminal run and writes an experiment_trials row per trial", async () => {
    const cell = fakeCell(2);
    const { deps: d, cap } = deps(cell);
    const result = await runCellTrials(d, ORG, cell);

    expect(cap.persisted.map((p) => p.trialIndex)).toEqual([0, 1]);
    expect(cap.persisted.map((p) => p.runId)).toEqual(["run_0", "run_1"]);
    expect(result.trials.every((t) => t.trialRowWritten)).toBe(true);
    expect(result.trials.every((t) => t.terminated)).toBe(true);
  });

  it("runs the accept step on a merged trial and threads its result + reachedAcceptGreen", async () => {
    const cell = fakeCell(1);
    const { deps: d, cap } = deps(cell, { merged: true, accept: "failed" });
    const result = await runCellTrials(d, ORG, cell);

    // Accept ran post-merge.
    expect(cap.accepted).toEqual([0]);
    expect(result.trials[0]!.acceptResult).toBe("failed");
    // A merged trial with a failed accept records reachedAcceptGreen=false.
    expect(cap.persisted[0]!.acceptResult).toBe("failed");
    expect(cap.persisted[0]!.reachedAcceptGreen).toBe(false);
  });

  it("skips accept on a non-merged trial (null result, reachedAcceptGreen null)", async () => {
    const cell = fakeCell(1);
    const { deps: d, cap } = deps(cell, { merged: false });
    const result = await runCellTrials(d, ORG, cell);

    // Accept never ran (no merge).
    expect(cap.accepted).toEqual([]);
    expect(result.trials[0]!.acceptResult).toBeNull();
    expect(cap.persisted[0]!.acceptResult).toBeNull();
    expect(cap.persisted[0]!.reachedAcceptGreen).toBeNull();
  });

  it("writes no trial row when the run never reached a terminal state", async () => {
    const cell = fakeCell(1);
    const { deps: d, cap } = deps(cell, { merged: false, terminate: false });
    const result = await runCellTrials(d, ORG, cell);

    expect(cap.persisted).toEqual([]);
    expect(result.trials[0]!.trialRowWritten).toBe(false);
    expect(result.trials[0]!.terminated).toBe(false);
  });
});

describe("projectConfigFromFrozen", () => {
  it("maps the frozen dimensions onto a valid project ConfigV1", () => {
    const config = projectConfigFromFrozen(frozen("cheap")) as Record<string, unknown>;
    expect(config["version"]).toBe(1);
    expect(config["governancePosture"]).toBe("strict");
    expect(config["mergeIntegration"]).toBe("not_configured");
    const routing = config["routing"] as { write: { chain: Array<{ model: string }> } };
    expect(routing.write.chain[0]!.model).toBe("cheap");
  });
});
