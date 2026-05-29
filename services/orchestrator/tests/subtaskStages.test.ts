import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import {
  runAuditorStage,
  runCheckerStage,
  runPlannerStage,
  runWriterStage,
} from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import {
  buildPlan,
  failingCheck,
  loopAudit,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeWriter,
  passingAudit,
  passingCheck,
} from "./helpers/plannerLoopHelpers.js";

// subtaskStages.ts owns the per-call event timeline + task-row transitions for
// each planner/writer/checker/auditor invocation. The mutation survivors were
// almost entirely event-name / payload string literals, array spreads, and the
// commit-sha fallback — exercised by the loop tests but never asserted at the
// payload level. These tests call each stage directly with a recording
// appendEvent + fake pool and pin the emitted event names, the task kinds, the
// payload values, and the outcome branch.

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

class StageHarness {
  readonly events: RecordedEvent[] = [];
  readonly tasks: Array<{ taskId: string; kind: string; title: string; parentTaskId: string | null }> = [];
  readonly taskOutcomes = new Map<string, string>();
  readonly costRecords: Array<{ taskId: string; model: string; cli: string; runtimeSeconds: number }> = [];

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  // pg-shaped query stub: records the task INSERTs / outcome UPDATEs the
  // stages issue so we can assert task-row transitions without a database.
  query = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO tasks") && trimmed.includes("parent_task_id")) {
      this.tasks.push({
        taskId: String(params[0]),
        kind: String(params[2]),
        title: String(params[3]),
        parentTaskId: params[4] === null ? null : String(params[4]),
      });
    } else if (trimmed.startsWith("UPDATE tasks SET status")) {
      this.taskOutcomes.set(String(params[0]), String(params[1]));
    }
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async (context: { taskId: string; model: string; cli: string; runtimeSeconds: number }) => {
        this.costRecords.push({
          taskId: context.taskId,
          model: context.model,
          cli: context.cli,
          runtimeSeconds: context.runtimeSeconds,
        });
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  names(): EventName[] {
    return this.events.map((event) => event.eventType);
  }

  find(eventType: EventName): RecordedEvent | undefined {
    return this.events.find((event) => event.eventType === eventType);
  }
}

const subtask: PlanSubtask = {
  index: 0,
  title: "Wire behavior B1",
  intent: "touch the README",
  behaviorIds: ["B1", "B2"],
  estimatedTokens: null,
};

describe("runPlannerStage", () => {
  it("emits planner.subtasks.emitted with the plan subtasks + rationale and records planner cost", async () => {
    const h = new StageHarness();
    const plan = buildPlan([{ title: "Wire behavior B1", intent: "touch the README", behaviorIds: ["B1", "B2"] }]);
    const result = await runPlannerStage({
      pool: { query: h.query },
      costCtx: h.costCtx(),
      adapter: makePlanner([plan]),
      spec: { specTitle: "S", specDescription: "D", acceptanceCriteria: ["AC1"], behaviorIds: [], behaviorContext: [] },
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      appendEvent: h.appendEvent,
      attempt: 2,
      rejectionHistory: [],
      timeoutMs: 1000,
    });

    expect(result).toBe(plan);
    const emitted = h.find("planner.subtasks.emitted");
    expect(emitted).toBeDefined();
    expect(emitted!.taskId).toBe("task_plan");
    expect(emitted!.payload.runId).toBe("run_1");
    expect(emitted!.payload.rationale).toBe(plan.rationale);
    const subtasks = emitted!.payload.subtasks as Array<Record<string, unknown>>;
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]).toMatchObject({ index: 0, title: "Wire behavior B1", intent: "touch the README" });
    // behaviorIds must be spread through (the [...] array survivor).
    expect(subtasks[0]!.behaviorIds).toEqual(["B1", "B2"]);

    expect(h.costRecords).toEqual([
      { taskId: "task_plan", model: "tanren-planner", cli: "fake", runtimeSeconds: expect.any(Number) },
    ]);
    expect(h.costRecords[0]!.runtimeSeconds).toBeGreaterThan(0);
  });
});

describe("runWriterStage", () => {
  it("emits the write task timeline with the commit sha and diff byte length", async () => {
    const h = new StageHarness();
    await runWriterStage({
      pool: { query: h.query },
      costCtx: h.costCtx(),
      adapter: makeWriter(["diff body\n"]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
    });

    expect(h.names()).toEqual(["task.started", "writer.subtask.started", "writer.subtask.completed", "task.completed"]);
    // task.started / task.completed carry taskKind "write".
    expect(h.find("task.started")!.payload.taskKind).toBe("write");
    expect(h.find("task.completed")!.payload.taskKind).toBe("write");

    const started = h.find("writer.subtask.started")!;
    expect(started.payload.subtaskIndex).toBe(0);
    expect(started.payload.intent).toBe("touch the README");
    expect(started.payload.behaviorIds).toEqual(["B1", "B2"]);

    const completed = h.find("writer.subtask.completed")!;
    expect(completed.payload.diffBytes).toBe(Buffer.byteLength("diff body\n", "utf8"));
    // Non-empty diff -> writer returns a commit -> commitSha is the first sha.
    expect(completed.payload.commitSha).toBe("sha_1");

    // Child task inserted as a "write" under the planner, then marked passed.
    expect(h.tasks).toEqual([
      {
        taskId: "task_write",
        kind: "write",
        title: expect.stringContaining("write subtask 0"),
        parentTaskId: "task_plan",
      },
    ]);
    expect(h.taskOutcomes.get("task_write")).toBe("passed");
  });

  it("reports commitSha null when the writer produces an empty diff (no commit)", async () => {
    const h = new StageHarness();
    await runWriterStage({
      pool: { query: h.query },
      costCtx: h.costCtx(),
      adapter: makeWriter([""]),
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      subtask,
      writeTaskId: "task_write",
      prompt: "write it",
      timeoutMs: 1000,
      appendEvent: h.appendEvent,
    });
    const completed = h.find("writer.subtask.completed")!;
    expect(completed.payload.commitSha).toBeNull();
    expect(completed.payload.diffBytes).toBe(0);
  });
});

function checkerArgs(h: StageHarness, verdict: typeof passingCheck) {
  return {
    pool: { query: h.query },
    costCtx: h.costCtx(),
    adapter: makeChecker([verdict]),
    runId: "run_1",
    workspacePath: "/ws",
    writeTaskId: "task_write",
    checkerTaskId: "task_check",
    subtask,
    writerResult: { diff: "d", commits: [], exitReason: "completed" as const },
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

function auditorArgs(h: StageHarness, verdict: typeof passingAudit) {
  return {
    pool: { query: h.query },
    costCtx: h.costCtx(),
    adapter: makeAuditor([verdict]),
    runId: "run_1",
    workspacePath: "/ws",
    plannerTaskId: "task_plan",
    plan: buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]),
    combinedDiff: "diff",
    specTitle: "S",
    specDescription: "D",
    acceptanceCriteria: ["AC1"],
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

describe("runCheckerStage", () => {
  it("emits checker.verdict with the passed flag + behavior id arrays and marks the check passed", async () => {
    const h = new StageHarness();
    const decision = await runCheckerStage(checkerArgs(h, passingCheck));

    expect(decision.kind).toBe("pass");
    const verdict = h.find("checker.verdict")!;
    expect(verdict.payload.passed).toBe(true);
    expect(verdict.payload.reasoning).toBe(passingCheck.reasoning);
    expect(verdict.payload.behaviorIdsPassed).toEqual(["B1"]);
    expect(verdict.payload.behaviorIdsFailed).toEqual([]);
    expect(h.names()).not.toContain("checker.rejected");
    expect(h.taskOutcomes.get("task_check")).toBe("passed");
  });

  it("emits checker.rejected and marks rejected_by_checker on a failing verdict", async () => {
    const h = new StageHarness();
    const decision = await runCheckerStage(checkerArgs(h, failingCheck));

    expect(decision.kind).toBe("reject");
    expect(h.names()).toContain("checker.rejected");
    const rejected = h.find("checker.rejected")!;
    expect(rejected.payload.subtaskIndex).toBe(0);
    expect(rejected.payload.behaviorIdsFailed).toEqual(["B1"]);
    expect(h.taskOutcomes.get("task_check")).toBe("rejected_by_checker");
  });
});

describe("runAuditorStage", () => {
  it("emits auditor.verdict and marks the audit passed on a pass decision", async () => {
    const h = new StageHarness();
    const { decision, auditorTaskId } = await runAuditorStage(auditorArgs(h, passingAudit));

    expect(decision.kind).toBe("pass");
    const verdict = h.find("auditor.verdict")!;
    expect(verdict.payload.passed).toBe(true);
    expect(verdict.payload.recommendedAction).toBe("pass");
    expect(verdict.payload.outstandingBehaviorIds).toEqual([]);
    expect(h.names()).not.toContain("auditor.rejected");
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("passed");
    // task.* events for the auditor carry the "audit" kind.
    expect(h.find("task.started")!.payload.taskKind).toBe("audit");
    expect(h.find("task.completed")!.payload.taskKind).toBe("audit");
  });

  it("emits auditor.rejected with the recommended action + outstanding ids on a non-pass decision", async () => {
    const h = new StageHarness();
    const { decision, auditorTaskId } = await runAuditorStage(auditorArgs(h, loopAudit));

    expect(decision.kind).not.toBe("pass");
    expect(h.names()).toContain("auditor.rejected");
    const rejected = h.find("auditor.rejected")!;
    expect(rejected.payload.recommendedAction).toBe("loop_to_planner");
    expect(rejected.payload.outstandingBehaviorIds).toEqual(["B2"]);
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("rejected_by_auditor");
  });
});
