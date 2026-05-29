// P2A-0012: planner-feedback-loop integration tests. Each test wires the
// loop with in-memory adapters from helpers/plannerLoopHelpers and asserts
// on the event timeline + task-row shape produced by runSubtaskLoop.
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { decideAuditorOutcome } from "../src/engine/workflow/auditor/auditor.js";
import { buildCheckerPrompt, decideCheckerOutcome } from "../src/engine/workflow/checker/checker.js";
import { buildPlannerPrompt } from "../src/engine/workflow/planner/planner.js";
import {
  buildPlan,
  defaultLoopInput,
  failingCheck,
  haltAudit,
  loopAudit,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";

describe("subtask loop — positive path", () => {
  it("dispatches subtasks in order and reports pass when checker + auditor agree", async () => {
    const { input, pool, events } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.plannerRerunCount).toBe(0);
    expect(outcome.subtasks).toHaveLength(1);

    const taskKinds = pool.tasks.map((task) => task.kind);
    expect(taskKinds).toEqual(["plan", "write", "check", "audit"]);
    const planner = pool.tasks.find((task) => task.kind === "plan")!;
    const writer = pool.tasks.find((task) => task.kind === "write")!;
    const checker = pool.tasks.find((task) => task.kind === "check")!;
    const auditor = pool.tasks.find((task) => task.kind === "audit")!;
    expect(planner.parentTaskId).toBeNull();
    expect(writer.parentTaskId).toBe(planner.taskId);
    expect(checker.parentTaskId).toBe(writer.taskId);
    expect(auditor.parentTaskId).toBe(planner.taskId);
    expect(planner.outcome).toBe("passed");
    expect(writer.outcome).toBe("passed");
    expect(checker.outcome).toBe("passed");
    expect(auditor.outcome).toBe("passed");

    const eventNames = events.events.map((event) => event.eventType);
    expect(eventNames).toContain("planner.subtasks.emitted");
    expect(eventNames).toContain("writer.subtask.completed");
    expect(eventNames).toContain("checker.verdict");
    expect(eventNames).toContain("auditor.verdict");
    expect(eventNames.filter((name) => name === "cost.resolved")).toHaveLength(4);
    expect(pool.costInserts).toHaveLength(4);
  });

  it("executes multiple subtasks in plan order with one writer task per subtask", async () => {
    const { input, pool, events } = defaultLoopInput({
      adapters: {
        planner: makePlanner([
          buildPlan([
            { title: "T1", intent: "Touch A", behaviorIds: ["B1"] },
            { title: "T2", intent: "Touch B", behaviorIds: ["B2"] },
            { title: "T3", intent: "Touch C", behaviorIds: ["B3"] },
          ]),
        ]),
        writer: makeWriter(["diff a\n", "diff b\n", "diff c\n"]),
        checker: makeChecker([passingCheck, passingCheck, passingCheck]),
        auditor: makeAuditor([passingAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    const subtaskWrites = events.events.filter((event) => event.eventType === "writer.subtask.completed");
    expect(subtaskWrites.map((event) => (event.payload as { subtaskIndex: number }).subtaskIndex)).toEqual([0, 1, 2]);
    expect(pool.costInserts).toHaveLength(8);
    const writes = pool.tasks.filter((task) => task.kind === "write");
    expect(writes).toHaveLength(3);
    const plannerTask = pool.tasks.find((t) => t.kind === "plan")!;
    expect(writes.every((task) => task.parentTaskId === plannerTask.taskId)).toBe(true);
  });
});

describe("subtask loop — checker rejection loop", () => {
  it("re-invokes the planner with the rejection reason and finishes on second plan", async () => {
    const failedPlan = buildPlan([{ title: "T1", intent: "Touch README", behaviorIds: ["B1"] }]);
    const successPlan = buildPlan([{ title: "T2", intent: "Touch README harder", behaviorIds: ["B1"] }]);
    const planner = makePlanner([failedPlan, successPlan]);
    const { input, events, pool } = defaultLoopInput({
      adapters: {
        planner,
        writer: makeWriter(["diff first attempt\n", "diff second attempt\n"]),
        checker: makeChecker([failingCheck, passingCheck]),
        auditor: makeAuditor([passingAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.plannerRerunCount).toBe(1);

    const rejected = events.events.find((event) => event.eventType === "checker.rejected");
    expect(rejected?.payload).toMatchObject({
      reason: failingCheck.reasoning,
      behaviorIdsFailed: ["B1"],
    });
    const rerequested = events.events.find((event) => event.eventType === "planner.rerequested");
    expect(rerequested?.payload).toMatchObject({
      producer: "checker",
      rejectionReason: failingCheck.reasoning,
      plannerRerunCount: 1,
      maxPlannerRerunsPerSpec: 3,
    });

    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[1]!.prompt).toContain("Prior rejections");
    expect(planner.calls[1]!.prompt).toContain(failingCheck.reasoning);

    const plannerCosts = pool.costInserts.filter(
      (insert) => pool.tasks.find((task) => task.taskId === insert.taskId)?.kind === "plan",
    );
    expect(plannerCosts).toHaveLength(2);
    const costResolved = events.events.filter((event) => event.eventType === "cost.resolved");
    expect(costResolved).toHaveLength(7);
  });
});

describe("subtask loop — auditor rejection loop", () => {
  it("loops back to the planner when the auditor recommends loop_to_planner", async () => {
    const planner = makePlanner([
      buildPlan([{ title: "T1", intent: "first attempt", behaviorIds: ["B1"] }]),
      buildPlan([{ title: "T1b", intent: "second attempt", behaviorIds: ["B1", "B2"] }]),
    ]);
    const { input, events } = defaultLoopInput({
      adapters: {
        planner,
        writer: makeWriter(["diff a\n", "diff b\n"]),
        checker: makeChecker([passingCheck, passingCheck]),
        auditor: makeAuditor([loopAudit, passingAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.plannerRerunCount).toBe(1);

    const rejected = events.events.find((event) => event.eventType === "auditor.rejected");
    expect(rejected?.payload).toMatchObject({
      recommendedAction: "loop_to_planner",
      reason: loopAudit.reasoning,
    });
    const rerequested = events.events.find((event) => event.eventType === "planner.rerequested");
    expect(rerequested?.payload).toMatchObject({ producer: "auditor", plannerRerunCount: 1 });

    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[1]!.prompt).toContain("Prior rejections");
    expect(planner.calls[1]!.prompt).toContain(loopAudit.reasoning);
  });

  it("halts immediately when the auditor recommends halt", async () => {
    const { input, events } = defaultLoopInput({
      adapters: {
        planner: makePlanner([buildPlan([{ title: "T1", intent: "doomed", behaviorIds: ["B1"] }])]),
        writer: makeWriter(["diff a\n"]),
        checker: makeChecker([passingCheck]),
        auditor: makeAuditor([haltAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("halted");
    if (outcome.kind !== "halted") return;
    expect(outcome.plannerRerunCount).toBe(0);
    expect(outcome.reason).toBe(haltAudit.reasoning);

    const rerequested = events.events.find((event) => event.eventType === "planner.rerequested");
    expect(rerequested).toBeUndefined();
  });
});

describe("subtask loop — budget exhaustion", () => {
  it("returns retry_budget_exhausted after maxPlannerRerunsPerSpec re-plans without success", async () => {
    const { input, events, pool } = defaultLoopInput({
      adapters: {
        planner: makePlanner([
          buildPlan([{ title: "T1", intent: "first", behaviorIds: ["B1"] }]),
          buildPlan([{ title: "T2", intent: "second", behaviorIds: ["B1"] }]),
          buildPlan([{ title: "T3", intent: "third", behaviorIds: ["B1"] }]),
        ]),
        writer: makeWriter(["diff 1\n", "diff 2\n", "diff 3\n"]),
        checker: makeChecker([failingCheck, failingCheck, failingCheck]),
        auditor: makeAuditor([passingAudit]),
      },
      escapeHatches: {
        maxPlannerRerunsPerSpec: 2,
        maxWriterIterPerSubtask: 5,
        maxRetriesPerTransientFailure: 3,
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("retry_budget_exhausted");
    if (outcome.kind !== "retry_budget_exhausted") return;
    expect(outcome.plannerRerunCount).toBeGreaterThan(2);
    expect(outcome.lastRejection.producer).toBe("checker");

    const unattributable = events.events.filter((event) => event.eventType === "cost.unattributable");
    expect(unattributable).toHaveLength(0);
    const costResolved = events.events.filter((event) => event.eventType === "cost.resolved");
    expect(costResolved).toHaveLength(9);
    expect(pool.costInserts).toHaveLength(9);

    const rerequested = events.events.filter((event) => event.eventType === "planner.rerequested");
    expect(rerequested).toHaveLength(2);
  });
});

describe("planner prompt + verdict decisions (pure)", () => {
  it("buildPlannerPrompt includes spec, behaviors, and rejection history", () => {
    const prompt = buildPlannerPrompt({
      spec: {
        specTitle: "ABC",
        specDescription: "do thing",
        acceptanceCriteria: ["criterion one"],
        behaviorIds: ["B1"],
        behaviorContext: [{ id: "B1", title: "B1 title", description: "B1 desc" }],
      },
      timeoutMs: 1_000,
      rejectionHistory: [
        {
          producer: "checker",
          rejectionReason: "missing file",
          behaviorIdsFailed: ["B1"],
          previousSubtasks: [
            {
              index: 0,
              title: "old",
              intent: "old intent",
              behaviorIds: ["B1"],
              estimatedTokens: null,
            },
          ],
        },
      ],
    });
    expect(prompt).toContain("ABC");
    expect(prompt).toContain("criterion one");
    expect(prompt).toContain("B1: B1 title");
    expect(prompt).toContain("Rejection #1 from checker");
    expect(prompt).toContain("missing file");
    expect(prompt).toContain("[0] old — old intent");
  });

  it("decideCheckerOutcome returns reject with reason+failed when passed=false", () => {
    expect(decideCheckerOutcome(passingCheck)).toEqual({ kind: "pass" });
    expect(decideCheckerOutcome(failingCheck)).toEqual({
      kind: "reject",
      reason: failingCheck.reasoning,
      behaviorIdsFailed: failingCheck.behaviorIdsFailed,
    });
  });

  // P3-0007: the checker is reframed to judge intent satisfaction only. The
  // prompt must forbid running/asserting tests/build/lint (a separate
  // deterministic gate owns correctness) and must require per-criterion
  // citation against the spec's explicit acceptance criteria.
  it("buildCheckerPrompt judges intent only and forbids running/asserting tests", () => {
    const prompt = buildCheckerPrompt({
      specTitle: "Spec",
      specDescription: "Do the thing.",
      acceptanceCriteria: ["AC1: file exists", "AC2: behavior wired"],
      subtask: {
        index: 0,
        title: "T1",
        intent: "wire the behavior",
        behaviorIds: ["B1"],
        estimatedTokens: null,
      },
      writerDiff: "diff --git a/x b/x\n",
    });
    // Intent-only framing + explicit criteria are present.
    expect(prompt).toContain("intent");
    expect(prompt).toContain("Explicit acceptance criteria");
    expect(prompt).toContain("AC1: file exists");
    expect(prompt).toContain("AC2: behavior wired");
    // Forbids running, simulating, or asserting tests/build/lint, and defers
    // correctness to a separate deterministic gate.
    expect(prompt).toMatch(/Do NOT run, simulate, invoke, or shell out to tests/);
    expect(prompt).toMatch(/Do NOT assert, claim, predict, or report whether tests/);
    expect(prompt).toMatch(/separate .*deterministic gate/i);
    // Requires citing each criterion in the rationale.
    expect(prompt).toMatch(/cite each acceptance criterion/i);
    // Still forbids workspace mutation.
    expect(prompt).toContain("Do NOT edit files");
  });

  it("an unmet acceptance criterion routes the checker verdict to rework", () => {
    // A verdict with passed=false (a criterion's intent is unmet) must drive
    // the reject/re-plan branch the loop consumes, unchanged by the reframe.
    const unmet: typeof failingCheck = {
      passed: false,
      reasoning: "AC2 intent not satisfied: behavior B1 was never wired.",
      behaviorIdsPassed: [],
      behaviorIdsFailed: ["B1"],
    };
    expect(decideCheckerOutcome(unmet)).toEqual({
      kind: "reject",
      reason: unmet.reasoning,
      behaviorIdsFailed: ["B1"],
    });
  });

  it("decideAuditorOutcome maps recommendedAction into the loop branch", () => {
    expect(decideAuditorOutcome(passingAudit)).toEqual({ kind: "pass" });
    const looped = decideAuditorOutcome(loopAudit);
    expect(looped).toEqual({
      kind: "reject",
      action: "loop_to_planner",
      reason: loopAudit.reasoning,
      outstandingBehaviorIds: loopAudit.outstandingBehaviorIds,
    });
    const halted = decideAuditorOutcome(haltAudit);
    expect(halted).toEqual({
      kind: "reject",
      action: "halt",
      reason: haltAudit.reasoning,
      outstandingBehaviorIds: haltAudit.outstandingBehaviorIds,
    });
  });
});
