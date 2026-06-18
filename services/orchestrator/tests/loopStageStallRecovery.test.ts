// LOOP-STAGE answerer-stall RECOVERY (Phase-2: loop-stage answerer stall → recoverable
// stage re-drive, NOT whole-spec restart). BINDING doctrine (feedback_no_timeouts_progress_based
// + feedback_robustness_over_recovery): a TRANSIENT answerer stall in a loop STAGE
// (checker / auditor / triage / convergence / demo-run / design-oracle) must NEVER throw
// away the spec loop's legitimate progress — it RE-DRIVES that stage in place; a genuinely-
// wedged stage (a stall on EVERY re-drive) escalates LOUDLY via the convergence judgment,
// NOT a hardcoded count.
//
// These exercise BOTH halves: the shared `runAnswererStageWithRecovery` primitive directly
// (recovers a transient stall; escalates a wedged stage at a proven fixed point; passes a
// deterministic error through), and the recovery wired through the real `runSubtaskLoop`
// (a transient stall on triage / convergence / demo / checker re-drives THAT stage and
// PRESERVES sibling progress — the planner runs ONCE, never a whole-spec restart).
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { runAnswererStageWithRecovery, StageStallEscalationError } from "../src/engine/workflow/loopStageRecovery.js";
import { AnswererStalledError } from "../src/engine/providers/answererSchemaError.js";
import {
  cleanAudit,
  completeCheck,
  convergenceProgress,
  defaultLoopInput,
  demoClean,
  makeAuditor,
  makeConvergence,
  makePlanner,
  makeStallingThenAnswer,
  makeTriage,
  makeWriter,
  triageAllTasks,
  buildPlan,
} from "./helpers/plannerLoopHelpers.js";

describe("runAnswererStageWithRecovery — the shared loop-stage stall recovery primitive", () => {
  it("RE-DRIVES a transient stall and returns the eventual answer (re-driven in place)", async () => {
    let calls = 0;
    const result = await runAnswererStageWithRecovery("triage", async () => {
      calls += 1;
      if (calls < 3) throw new AnswererStalledError("Triage");
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
    // It re-drove the SAME stage until it succeeded — never gave up after a fixed count.
    expect(calls).toBe(3);
  });

  it("ESCALATES a genuinely-wedged stage (stall on EVERY re-drive) via the convergence judgment", async () => {
    let calls = 0;
    await expect(
      runAnswererStageWithRecovery("convergence", async () => {
        calls += 1;
        throw new AnswererStalledError("Convergence");
      }),
    ).rejects.toThrow(StageStallEscalationError);
    // The escalation is the PROVEN fixed point (identical stall, no new information), not a
    // count — it stops after the detector confirms the wedge, having re-driven first.
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("does NOT swallow a deterministic (non-stall) error — it propagates verbatim", async () => {
    let calls = 0;
    await expect(
      runAnswererStageWithRecovery("auditor", async () => {
        calls += 1;
        throw new Error("ssh transport died");
      }),
    ).rejects.toThrow(/ssh transport died/u);
    // A deterministic error is NOT a transient stall — it is NOT re-driven (one call only).
    expect(calls).toBe(1);
  });
});

describe("loop-stage stall recovery wired through runSubtaskLoop (sibling progress preserved)", () => {
  it("a transient TRIAGE stall re-drives triage in place — the spec loop still passes, planner runs ONCE", async () => {
    const planner = makePlanner([buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }])]);
    // Triage stalls twice, then routes everything to NEW specs → the spec passes at once.
    const triage = makeStallingThenAnswer(
      { workItems: [{ id: "w", kind: "spec", severity: "P3", title: "later", body: "b", findingIds: ["f1"] }] },
      2,
    );
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner,
        auditor: makeAuditor([{ findings: [{ id: "f1", severity: "P0", title: "x", body: "y" }] }]),
        triage,
        convergence: makeConvergence([convergenceProgress]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // Triage was re-driven IN PLACE through the stalls (called >once); the planner ran ONCE
    // (NOT a whole-spec restart that would re-plan from scratch on a transient stall).
    expect(triage.calls.length).toBeGreaterThanOrEqual(3);
    expect(planner.calls.length).toBe(1);
  });

  it("a transient CONVERGENCE stall re-drives convergence in place (no whole-spec restart)", async () => {
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]),
      buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]),
    ]);
    const convergence = makeStallingThenAnswer(convergenceProgress, 2);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner,
        // First loop keeps work in-spec (→ convergence runs); second loop is clean → pass.
        auditor: makeAuditor([{ findings: [{ id: "f1", severity: "P0", title: "x", body: "y" }] }, cleanAudit]),
        triage: makeTriage([triageAllTasks, triageAllTasks]),
        convergence,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // Convergence stalled twice then progressed — re-driven IN PLACE, not a spec restart.
    expect(convergence.calls.length).toBeGreaterThanOrEqual(3);
    // The planner ran exactly TWICE (the two genuine loop iterations) — the transient
    // convergence stall did NOT trigger an extra whole-spec re-plan.
    expect(planner.calls.length).toBe(2);
  });

  it("a transient DEMO-RUN stall re-drives the demo stage in place — the spec loop still passes", async () => {
    const planner = makePlanner([buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }])]);
    const demo = makeStallingThenAnswer(demoClean, 2);
    const { input } = defaultLoopInput({
      convergencePolicy: { ...defaultConvergencePolicy(), demoRunEnabled: true },
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner,
        demoRun: demo,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(demo.calls.length).toBeGreaterThanOrEqual(3);
    expect(planner.calls.length).toBe(1);
  });

  it("a transient CHECKER stall re-drives the checker in place — the writer's diff is preserved", async () => {
    const planner = makePlanner([buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }])]);
    const writer = makeWriter(["diff --git a\n+x\n"]);
    const checker = makeStallingThenAnswer(completeCheck, 2);
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner,
        writer,
        checker,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // The checker re-drove through both stalls — the writer was NOT re-run for the stall
    // (one writer call: the diff was preserved, only the checker stage re-drove).
    expect(checker.calls.length).toBeGreaterThanOrEqual(3);
    expect(writer.calls.length).toBe(1);
  });

  it("a GENUINELY-WEDGED triage stage (stall every call) escalates LOUDLY (not a count)", async () => {
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([{ findings: [{ id: "f1", severity: "P0", title: "x", body: "y" }] }]),
        // Stalls on EVERY call → the convergence detector proves a fixed point → escalate.
        triage: makeStallingThenAnswer(triageAllTasks, Number.POSITIVE_INFINITY),
      },
    });
    await expect(runSubtaskLoop(input)).rejects.toThrow(StageStallEscalationError);
  });
});

// The balanced default convergence policy with the demo-run slot toggled on per test.
function defaultConvergencePolicy() {
  return {
    velocityDeferEnabled: false,
    velocityDeferMaxSeverity: "P3" as const,
    velocityDeferAfterStalls: 2,
    demoRunEnabled: false,
  };
}
