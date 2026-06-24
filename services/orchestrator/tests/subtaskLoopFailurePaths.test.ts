// Integration test for the apex v51 per-stage `task.failed` emit-on-throw doctrine sweep
// (timeout-eradication.md §1 disguised-survivor family — fifth survivor, sibling of #640).
//
// Walks a full failing planner attempt through the timeline at the `runSubtaskLoop`
// granularity: an answerer that throws `CodexUsageLimitError` (the exact apex v51
// shape — the Codex 5-hour subscription window exhausting mid-call) drives the loop,
// and the assertions pin the EVENT ORDERING + the per-task `task.failed` that used to
// be absent:
//
//   task.started{taskKind:plan} → task.failed{taskKind:plan, failureKind:window_exhausted}
//
// The throw RE-PROPAGATES out of `runSubtaskLoop` so the workflow's outer catch in
// plannerRun.ts:489 still runs the run-level disposition (`finalizeWorkflowThrow`
// finalizes `usage.window.pressure` + the run/spec/runner events). The DIFFERENCE
// from before this fix is the per-task `task.failed` event that now lands BEFORE the
// throw escapes — without it the planner `task` row would stay `running` forever
// (the apex v51 evidence: 3 stranded planner task rows).
//
// The same shape is exercised against the auditor + checker (the other two stages
// most likely to surface a usage-limit mid-run) — each of which used to let the
// throw escape silent at the per-task granularity.

import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import type { AuditAnswer, CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  defaultLoopInput,
  fakeAuthRef,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
} from "./helpers/plannerLoopHelpers.js";

function throwingAnswerer<T>(error: Error): AnswererAdapter<T> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: fakeAuthRef,
    async runAnswerer(): Promise<T> {
      throw error;
    },
  };
}

describe("subtaskLoop per-stage `task.failed` emit-on-throw (apex v51 doctrine sweep)", () => {
  it("planner-throw drives `task.started{plan}` → `task.failed{plan, window_exhausted}` before re-throwing", async () => {
    const planner = throwingAnswerer<PlanAnswer>(new CodexUsageLimitError("PlanAnswer", "5-hour window exhausted"));
    const { input, events } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, planner },
    });

    // The throw RE-PROPAGATES out of `runSubtaskLoop` — `plannerRun.ts`'s catch still routes
    // the run-level disposition (window pressure / re-driven). The PRE-FIX behavior left the
    // planner task row stranded `running`; the POST-FIX behavior lands the `task.failed`
    // event below BEFORE the throw escapes.
    await expect(runSubtaskLoop(input)).rejects.toBeInstanceOf(CodexUsageLimitError);

    const stage = events.events.map((e) => ({ eventType: e.eventType, taskId: e.taskId }));
    const startedIdx = stage.findIndex((e) => e.eventType === "task.started");
    const failedIdx = stage.findIndex((e) => e.eventType === "task.failed");
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(startedIdx);
    // The per-task `task.failed` carries the planner's task id + the correct kind + the
    // classified failureKind (the durable contract).
    const failed = events.events[failedIdx]!;
    expect(failed.payload).toMatchObject({ taskKind: "plan", failureKind: "window_exhausted" });
    expect(failed.taskId).toBeDefined();
    expect(failed.taskId).toBe(events.events[startedIdx]!.taskId);
  });

  it("auditor-throw drives `task.started{audit}` → `task.failed{audit, window_exhausted}` before re-throwing", async () => {
    const auditor = throwingAnswerer<AuditAnswer>(new CodexUsageLimitError("AuditAnswer", "5-hour window exhausted"));
    const { input, events } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, auditor },
    });

    await expect(runSubtaskLoop(input)).rejects.toBeInstanceOf(CodexUsageLimitError);

    // The auditor `task.started` arrives AFTER the planner's success path (planner.subtasks.emitted +
    // its task.completed); locate THAT auditor task by `taskKind: "audit"` on the started event.
    const startedAudit = events.events.find(
      (e) => e.eventType === "task.started" && (e.payload as { taskKind?: string }).taskKind === "audit",
    );
    const failedAudit = events.events.find(
      (e) => e.eventType === "task.failed" && (e.payload as { taskKind?: string }).taskKind === "audit",
    );
    expect(startedAudit).toBeDefined();
    expect(failedAudit).toBeDefined();
    expect(failedAudit!.taskId).toBe(startedAudit!.taskId);
    expect(failedAudit!.payload).toMatchObject({ taskKind: "audit", failureKind: "window_exhausted" });
  });

  it("checker-throw drives `task.started{check}` → `task.failed{check, window_exhausted}` before re-throwing", async () => {
    // The checker throws on its FIRST call (subtask 0); the writer/planner ran successfully
    // before that, so the timeline carries the planner's + writer's task.completed AND the
    // checker's started + failed.
    const checker = throwingAnswerer<CheckAnswer>(new CodexUsageLimitError("CheckAnswer", "5-hour window exhausted"));
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }])]),
        writer: makeWriter(["diff body\n"]),
        checker,
      },
    });

    await expect(runSubtaskLoop(input)).rejects.toBeInstanceOf(CodexUsageLimitError);

    const startedCheck = events.events.find(
      (e) => e.eventType === "task.started" && (e.payload as { taskKind?: string }).taskKind === "check",
    );
    const failedCheck = events.events.find(
      (e) => e.eventType === "task.failed" && (e.payload as { taskKind?: string }).taskKind === "check",
    );
    expect(startedCheck).toBeDefined();
    expect(failedCheck).toBeDefined();
    expect(failedCheck!.taskId).toBe(startedCheck!.taskId);
    expect(failedCheck!.payload).toMatchObject({ taskKind: "check", failureKind: "window_exhausted" });
  });

  it("triage-throw drives `task.started{triage}` → `task.failed{triage, window_exhausted}` before re-throwing", async () => {
    // The auditor must surface a finding so triage RUNS at all (a clean audit + no findings
    // would short-circuit triage entirely). One P1 finding routes the loop into triage.
    const triage = throwingAnswerer<{ workItems: never[] }>(
      new CodexUsageLimitError("TriageAnswer", "5-hour window exhausted"),
    ) as unknown as AnswererAdapter<{ workItems: never[] }>;
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([{ findings: [{ id: "f1", severity: "P0", title: "x", body: "y" }] }]),
        triage,
      },
    });

    await expect(runSubtaskLoop(input)).rejects.toBeInstanceOf(CodexUsageLimitError);

    const startedTriage = events.events.find(
      (e) => e.eventType === "task.started" && (e.payload as { taskKind?: string }).taskKind === "triage",
    );
    const failedTriage = events.events.find(
      (e) => e.eventType === "task.failed" && (e.payload as { taskKind?: string }).taskKind === "triage",
    );
    expect(startedTriage).toBeDefined();
    expect(failedTriage).toBeDefined();
    expect(failedTriage!.taskId).toBe(startedTriage!.taskId);
    expect(failedTriage!.payload).toMatchObject({ taskKind: "triage", failureKind: "window_exhausted" });
  });

  // Success-path baseline: a clean run lands `task.completed{plan}` (NOT `task.failed`) +
  // every other stage's `task.completed` arrives in order. Pins that the doctrine sweep
  // did not regress the success path.
  it("the clean success path lands `task.completed` on every stage (no `task.failed`)", async () => {
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        // Cleanest path: a single subtask passes its checker, the auditor is clean, the loop
        // exits PASSED without touching triage or convergence.
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(events.events.some((e) => e.eventType === "task.failed")).toBe(false);
    // Audit-trail integrity (critic-arc R1 #4 fix): the planner task ALSO emits
    // `task.completed` at the loop's terminal exit (clean pass / triage-passed /
    // velocity-pass) — see subtaskLoop.ts's markTaskDone sites for the planner.
    // PR #665 (A1+A2) covered the THROW path; this covers the SUCCESS terminations
    // that previously marked the row done but emitted nothing.
    const completedKinds = events.events
      .filter((e) => e.eventType === "task.completed")
      .map((e) => (e.payload as { taskKind?: string }).taskKind ?? "<no-kind>");
    expect(completedKinds).toContain("write");
    expect(completedKinds).toContain("check");
    expect(completedKinds).toContain("audit");
    expect(completedKinds).toContain("plan");
  });
});
