// P3-0005: the gate's routing inside runSubtaskLoop. A mock runGate stands in
// for the live exit-code gate so we can assert routing without a runner:
// - a fast-tier (per_iteration) fail routes back to writer rework via the
//   planner-rerequest path with producer="gate";
// - a slow-tier (pre_audit) fail blocks the audit and routes to rework;
// - an all-pass gate routes forward (audit runs, run passes);
// - gate failures count against the planner-rerun budget.
import { describe, expect, it } from "vitest";
import type { CiWhen } from "../src/engine/ci/index.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import {
  buildPlan,
  defaultLoopInput,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
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
    // Fast tier after the writer iteration, slow tier before the audit.
    expect(calls.map((c) => c.when)).toEqual(["per_iteration", "pre_audit"]);
    expect(events.events.some((e) => e.eventType === "auditor.verdict")).toBe(true);
  });

  it("routes a fast-tier (per_iteration) fail to writer rework and re-plans", async () => {
    // First iteration: fast gate fails → rework. Second iteration: all pass.
    const { runGate, calls } = scriptedGate([failGate("fast", "per_iteration", "lint"), passGate, passGate]);
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "first", behaviorIds: ["B1"] }]),
      buildPlan([{ title: "T2", intent: "second", behaviorIds: ["B1"] }]),
    ]);
    const { input, events } = defaultLoopInput({
      runGate,
      adapters: {
        planner,
        writer: makeWriter(["diff one\n", "diff two\n"]),
        checker: makeChecker([passingCheck, passingCheck]),
        auditor: makeAuditor([passingAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome).toMatchObject({ kind: "passed", plannerRerunCount: 1 });
    const rerequested = events.events.find((e) => e.eventType === "planner.rerequested");
    expect(rerequested?.payload).toMatchObject({ producer: "gate", plannerRerunCount: 1 });
    // The first call was the failing fast tier (the checker never ran on the
    // broken tree — only writer ran before the gate).
    expect(calls[0]!.when).toBe("per_iteration");
    expect(planner.calls).toHaveLength(2);
  });

  it("blocks the audit when the slow tier (pre_audit) fails and routes to rework", async () => {
    // First plan: fast passes, slow (pre_audit) fails → rework before audit.
    // Second plan: both pass → audit runs and passes.
    const { runGate, calls } = scriptedGate([passGate, failGate("slow", "pre_audit", "build"), passGate, passGate]);
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "first", behaviorIds: ["B1"] }]),
      buildPlan([{ title: "T2", intent: "second", behaviorIds: ["B1"] }]),
    ]);
    const auditor = makeAuditor([passingAudit]);
    const { input, events } = defaultLoopInput({
      runGate,
      adapters: {
        planner,
        writer: makeWriter(["diff one\n", "diff two\n"]),
        checker: makeChecker([passingCheck, passingCheck]),
        auditor,
      },
    });
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    // The auditor ran exactly once — only after the second plan, never on the
    // first plan whose pre_audit gate failed.
    expect(auditor.calls).toHaveLength(1);
    expect(calls.map((c) => c.when)).toEqual(["per_iteration", "pre_audit", "per_iteration", "pre_audit"]);
    const rerequested = events.events.filter((e) => e.eventType === "planner.rerequested");
    expect(rerequested).toHaveLength(1);
    expect(rerequested[0]!.payload).toMatchObject({ producer: "gate" });
  });

  it("exhausts the planner-rerun budget when the gate keeps failing", async () => {
    const { runGate } = scriptedGate([failGate("fast", "per_iteration", "lint")]);
    const { input } = defaultLoopInput({
      runGate,
      escapeHatches: {
        maxPlannerRerunsPerSpec: 1,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome).toMatchObject({
      kind: "retry_budget_exhausted",
      lastRejection: { producer: "gate" },
    });
  });

  it("runs no gate when runGate is omitted (legacy path)", async () => {
    const { input, events } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(events.events.some((e) => e.eventType.startsWith("gate."))).toBe(false);
  });
});
