// rv-premerge — proof that the merge stage's pre-merge behavior gate is a GENUINE zero-cost
// no-op when the project did not opt in (knob OFF) or no producer is wired: `produce` is
// NEVER invoked, so NO preview deploy happens. Also proves the opt-in path forwards the
// producer's `passed`/`not_applicable` as `proceed` and only `blocked` would halt.

import { describe, expect, it, vi } from "vitest";
import { runPreMergeBehaviorGate } from "../src/engine/workflow/plannerRunPreMergeBehavior.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type {
  PreMergeBehaviorGateOutcome,
  PreMergeBehaviorGateProducer,
} from "../src/engine/verification/preMerge/preMergeBehaviorGateProducer.js";

function ctx(preMergeBehaviorGate?: boolean): PlannerRunContext {
  const base: Record<string, unknown> = {
    runId: "run1",
    specId: "spec1",
    projectId: "proj1",
    orgId: "org1",
    repoUrl: "https://github.com/acme/web.git",
    behaviorIds: ["br1"],
  };
  if (preMergeBehaviorGate !== undefined) base["preMergeBehaviorGate"] = preMergeBehaviorGate;
  return base as unknown as PlannerRunContext;
}

function inputWith(producer?: PreMergeBehaviorGateProducer): RunPlannerLoopInput {
  const base: Record<string, unknown> = {};
  if (producer !== undefined) base["preMergeBehaviorProducer"] = producer;
  return base as unknown as RunPlannerLoopInput;
}

const STAGE = {
  finalizeRunState: {} as never,
  // A finalize should NEVER be reached on the proceed paths — appendEvent throws if called.
  appendEvent: vi.fn<() => Promise<void>>(() => {
    throw new Error("appendEvent must not be called on a proceed path");
  }),
};

function producerReturning(outcome: PreMergeBehaviorGateOutcome): {
  producer: PreMergeBehaviorGateProducer;
  produce: ReturnType<typeof vi.fn>;
} {
  const produce = vi.fn<() => Promise<PreMergeBehaviorGateOutcome>>(async () => outcome);
  return { producer: { produce }, produce };
}

describe("runPreMergeBehaviorGate — opt-in, default-off wiring", () => {
  it("knob OFF (undefined) → proceed and NO preview deploy (produce never called)", async () => {
    const { producer, produce } = producerReturning({ kind: "passed", runId: "vr1", passedBlockingCount: 1 });
    const result = await runPreMergeBehaviorGate(inputWith(producer), ctx(), STAGE, "deadbeef");
    expect(result).toBe("proceed");
    expect(produce).not.toHaveBeenCalled();
  });

  it("knob explicitly false → proceed, produce never called", async () => {
    const { producer, produce } = producerReturning({ kind: "passed", runId: "vr1", passedBlockingCount: 1 });
    expect(await runPreMergeBehaviorGate(inputWith(producer), ctx(false), STAGE, "deadbeef")).toBe("proceed");
    expect(produce).not.toHaveBeenCalled();
  });

  it("knob ON but NO producer wired → proceed (no deploy possible)", async () => {
    expect(await runPreMergeBehaviorGate(inputWith(), ctx(true), STAGE, "deadbeef")).toBe("proceed");
  });

  it("knob ON + producer passes → proceed, produce called with the run + head bindings", async () => {
    const { producer, produce } = producerReturning({ kind: "passed", runId: "vr1", passedBlockingCount: 2 });
    expect(await runPreMergeBehaviorGate(inputWith(producer), ctx(true), STAGE, "deadbeef")).toBe("proceed");
    expect(produce).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run1", headSha: "deadbeef", behaviorRevisionIds: ["br1"], orgId: "org1" }),
    );
  });

  it("knob ON + producer not_applicable → proceed", async () => {
    const { producer } = producerReturning({ kind: "not_applicable", reason: "no web surface" });
    expect(await runPreMergeBehaviorGate(inputWith(producer), ctx(true), STAGE, "deadbeef")).toBe("proceed");
  });
});
