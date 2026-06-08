// The deterministic gate's routing inside runSubtaskLoop (SPEC-LOOP REDESIGN,
// docs/roadmap/spec-loop-redesign.md). A mock runGate stands in for the live exit-code
// gate so we can assert routing without a runner:
// - the FAST tier (per_iteration) runs BEFORE the checker; a fail loops straight back
//   to the writer (no checker call on a broken tree);
// - the SPEC gate (pre_audit) runs at spec completion; a CI fail becomes a P0 FINDING
//   that joins the triage set (NOT a halt);
// - an all-pass gate routes forward (audit runs, run passes).
// There is NO planner-rerun budget / retry-cap halt — the convergence answerer is the
// sole loop bound.
import { describe, expect, it } from "vitest";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  cleanAudit,
  completeCheck,
  convergenceProgress,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makePlanner,
  makeTriage,
  makeWriter,
  triageAllSpecs,
  triageAllTasks,
  buildPlan,
} from "./helpers/plannerLoopHelpers.js";

const passGate: GateOutcome = { passed: true, results: [] };

function failGate(tier: string, when: CiWhen, failedStep: string): GateOutcome {
  return {
    passed: false,
    results: [],
    failure: { passed: false, tier, when, failedStep, exitCode: 1, steps: [] },
  };
}

// Records every gate invocation and returns a scripted outcome per call.
function scriptedGate(outcomes: ReadonlyArray<GateOutcome>) {
  const calls: { when: CiWhen; taskId?: string }[] = [];
  let index = 0;
  const runGate = async (input: { when: CiWhen; taskId?: string }): Promise<GateOutcome> => {
    calls.push(input);
    const outcome = outcomes[index] ?? outcomes.at(-1) ?? passGate;
    index += 1;
    return outcome;
  };
  return { runGate, calls };
}

describe("gate routing in the subtask loop", () => {
  it("routes forward (audit runs, run passes) when both gate tiers pass", async () => {
    const { runGate, calls } = scriptedGate([passGate, passGate]);
    const { input, events } = defaultLoopInput({ runGate });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // Fast tier after the writer iteration, spec tier before the audit.
    expect(calls.map((c) => c.when)).toEqual(["per_iteration", "pre_audit"]);
    expect(events.events.some((e) => e.eventType === "auditor.verdict")).toBe(true);
  });

  it("routes a FAST-tier (per_iteration) fail straight back to the writer BEFORE the checker", async () => {
    // First per_iteration gate fails → rewrite (no checker). Second passes → checker.
    const { runGate, calls } = scriptedGate([failGate("fast", "per_iteration", "lint"), passGate, passGate]);
    const checker = makeChecker([completeCheck]);
    const { input, pool } = defaultLoopInput({
      runGate,
      adapters: {
        ...defaultLoopInput().input.adapters,
        writer: makeWriter(["one\n", "two\n"]),
        checker,
        auditor: makeAuditor([cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // The checker ran ONLY after a passing fast gate (the failing fast gate
    // short-circuited to the writer first).
    expect(checker.calls).toHaveLength(1);
    expect(calls[0]!.when).toBe("per_iteration");
    expect(pool.tasks.filter((t) => t.kind === "write")).toHaveLength(2);
  });

  it("a SPEC-gate (pre_audit) CI fail becomes a P0 finding routed through triage (NOT a halt)", async () => {
    // The spec gate fails on the first loop → its P0 finding joins triage, which routes
    // ALL to new specs → the spec PASSES (never halts on the gate).
    const { runGate } = scriptedGate([passGate, failGate("slow", "pre_audit", "build")]);
    const { input, events } = defaultLoopInput({
      runGate,
      adapters: {
        ...defaultLoopInput().input.adapters,
        triage: makeTriage([triageAllSpecs]),
      },
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The gate failure was triaged into a new DAG spec — never a halt.
    expect(outcome.newSpecs.length).toBeGreaterThan(0);
    // Triage ran (the spec-gate P0 finding reached it) and routed everything to specs.
    const triage = events.events.find((e) => e.eventType === "triage.completed")!;
    expect((triage.payload as { outcome: string }).outcome).toBe("passed");
  });

  it("a recurring SPEC-gate fail kept in-spec is bounded by CONVERGENCE, never a retry cap", async () => {
    // The spec gate fails every loop; triage keeps it in-spec. The loop is bounded ONLY
    // by the convergence stall counter — here progress on loop 1, then a clean gate on
    // loop 2 → PASS. (No retry-cap halt exists.)
    // loop1: fast pass, spec-gate FAILS (→ P0 finding kept in-spec); loop2: both pass.
    const { runGate } = scriptedGate([passGate, failGate("slow", "pre_audit", "build"), passGate, passGate]);
    const { input } = defaultLoopInput({
      runGate,
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T", intent: "i", behaviorIds: ["B1"] }])]),
        triage: makeTriage([triageAllTasks]),
        convergence: makeConvergence([convergenceProgress]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
  });

  it("runs no gate when runGate is omitted (unit path)", async () => {
    const { input, events } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(events.events.some((e) => e.eventType.startsWith("gate."))).toBe(false);
  });
});
