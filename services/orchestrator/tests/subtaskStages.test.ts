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

interface RecordedTask {
  taskId: string;
  kind: string;
  title: string;
  parentTaskId: string | null;
  agentKind: string;
  cli: string;
  model: string | null;
}

interface RecordedCost {
  taskId: string;
  model: string;
  cli: string;
  authRef: string;
  runtimeSeconds: number;
  tokenUsage: Record<string, unknown>;
  rawUsage: Record<string, unknown>;
}

class StageHarness {
  readonly events: RecordedEvent[] = [];
  readonly tasks: RecordedTask[] = [];
  readonly taskOutcomes = new Map<string, string>();
  readonly costRecords: RecordedCost[] = [];

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  // pg-shaped query stub: records the task INSERTs / outcome UPDATEs the
  // stages issue so we can assert task-row transitions without a database.
  // The INSERT param order is taskId, runId, kind, title, parent_task_id,
  // agent_kind, cli, model — see insertChildTask in subtaskTasks.ts.
  query = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO tasks") && trimmed.includes("parent_task_id")) {
      this.tasks.push({
        taskId: String(params[0]),
        kind: String(params[2]),
        title: String(params[3]),
        parentTaskId: params[4] === null ? null : String(params[4]),
        agentKind: String(params[5]),
        cli: String(params[6]),
        model: params[7] === null ? null : String(params[7]),
      });
    } else if (trimmed.startsWith("UPDATE tasks SET status")) {
      this.taskOutcomes.set(String(params[0]), String(params[1]));
    }
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async (
        context: { taskId: string; model: string; cli: string; authRef: string; runtimeSeconds: number },
        tokenUsage: Record<string, unknown>,
        rawUsage: Record<string, unknown>,
      ) => {
        this.costRecords.push({
          taskId: context.taskId,
          model: context.model,
          cli: context.cli,
          authRef: context.authRef,
          runtimeSeconds: context.runtimeSeconds,
          tokenUsage,
          rawUsage,
        });
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  task(taskId: string): RecordedTask {
    const found = this.tasks.find((t) => t.taskId === taskId);
    if (found === undefined) throw new Error(`no task inserted for ${taskId}`);
    return found;
  }

  cost(taskId: string): RecordedCost {
    const found = this.costRecords.find((c) => c.taskId === taskId);
    if (found === undefined) throw new Error(`no cost recorded for ${taskId}`);
    return found;
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

    const cost = h.cost("task_plan");
    expect(cost.model).toBe("tanren-planner");
    expect(cost.cli).toBe("fake");
    expect(cost.runtimeSeconds).toBeGreaterThan(0);
    // Default rawUsage (no buildUsage override) must carry the planner role +
    // attempt — pins the `?? { role: "planner", attempt }` default object.
    expect(cost.rawUsage).toEqual({ role: "planner", attempt: 2 });
  });

  it("uses the buildUsage override for rawUsage when provided", async () => {
    const h = new StageHarness();
    const plan = buildPlan([{ title: "T", intent: "i", behaviorIds: ["B1"] }]);
    await runPlannerStage({
      pool: { query: h.query },
      costCtx: h.costCtx(),
      adapter: makePlanner([plan]),
      spec: { specTitle: "S", specDescription: "D", acceptanceCriteria: ["AC1"], behaviorIds: [], behaviorContext: [] },
      runId: "run_1",
      workspacePath: "/ws",
      plannerTaskId: "task_plan",
      appendEvent: h.appendEvent,
      attempt: 4,
      rejectionHistory: [],
      timeoutMs: 1000,
      buildUsage: ({ plannerTaskId, attempt }) => ({ custom: true, plannerTaskId, attempt }),
    });
    // The override replaces the default object entirely (the `??` left arm).
    expect(h.cost("task_plan").rawUsage).toEqual({ custom: true, plannerTaskId: "task_plan", attempt: 4 });
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
    const row = h.task("task_write");
    expect(row.kind).toBe("write");
    expect(row.title).toContain("write subtask 0");
    expect(row.parentTaskId).toBe("task_plan");
    // The write row is owned by the writer agent and carries the adapter cli +
    // a null model (writer model is recorded on the cost row, not the task).
    expect(row.agentKind).toBe("writer");
    expect(row.cli).toBe("fake");
    expect(row.model).toBeNull();
    expect(h.taskOutcomes.get("task_write")).toBe("passed");

    // Writer cost: fixed model, adapter cli/authRef, the writer's token usage,
    // and the default rawUsage carrying role/attempt/subtaskIndex.
    const cost = h.cost("task_write");
    expect(cost.model).toBe("tanren-writer");
    expect(cost.cli).toBe("fake");
    expect(cost.tokenUsage).toMatchObject({ totalTokens: 2 });
    expect(cost.rawUsage).toEqual({ role: "writer", attempt: 1, subtaskIndex: 0 });
  });

  it("reports diffBytes as the utf8 byte length, not the code-point count", async () => {
    const h = new StageHarness();
    // "é" + "あ" are multibyte in utf8 (2 + 3 bytes) so the byte length differs
    // from the JS string length — pins Buffer.byteLength(diff, "utf8").
    const diff = "éあ";
    await runWriterStage({
      pool: { query: h.query },
      costCtx: h.costCtx(),
      adapter: makeWriter([diff]),
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
    expect(completed.payload.diffBytes).toBe(5);
    expect(completed.payload.diffBytes).not.toBe(diff.length);
  });

  it("uses the buildUsage override for the writer rawUsage when provided", async () => {
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
      buildUsage: ({ subtaskTaskId, subtaskIndex }) => ({ custom: "w", subtaskTaskId, subtaskIndex }),
    });
    expect(h.cost("task_write").rawUsage).toEqual({ custom: "w", subtaskTaskId: "task_write", subtaskIndex: 0 });
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

    // Insert metadata: a "check subtask N" title under the writer, owned by the
    // answerer agent, carrying the adapter cli + null model.
    const row = h.task("task_check");
    expect(row.title).toBe("check subtask 0");
    expect(row.parentTaskId).toBe("task_write");
    expect(row.agentKind).toBe("answerer");
    expect(row.cli).toBe("fake");
    expect(row.model).toBeNull();

    // task.started / checker.started both carry the "check" kind.
    expect(h.find("task.started")!.payload.taskKind).toBe("check");
    expect(h.find("checker.started")!.payload.taskKind).toBe("check");
    // The pass-branch task.completed also carries the "check" kind.
    expect(h.find("task.completed")!.payload.taskKind).toBe("check");

    // Checker cost: fixed model + default rawUsage role/subtaskIndex.
    const cost = h.cost("task_check");
    expect(cost.model).toBe("tanren-checker");
    expect(cost.rawUsage).toEqual({ role: "checker", subtaskIndex: 0 });
  });

  it("emits checker.rejected and marks rejected_by_checker on a failing verdict", async () => {
    const h = new StageHarness();
    const decision = await runCheckerStage(checkerArgs(h, failingCheck));

    expect(decision.kind).toBe("reject");
    expect(h.names()).toContain("checker.rejected");
    // The verdict event (emitted before the decision branch) must carry the
    // failed behavior ids spread through — pins behaviorIdsFailed: [...].
    const verdict = h.find("checker.verdict")!;
    expect(verdict.payload.passed).toBe(false);
    expect(verdict.payload.behaviorIdsFailed).toEqual(["B1"]);
    const rejected = h.find("checker.rejected")!;
    expect(rejected.payload.subtaskIndex).toBe(0);
    expect(rejected.payload.behaviorIdsFailed).toEqual(["B1"]);
    expect(h.taskOutcomes.get("task_check")).toBe("rejected_by_checker");
    // The reject-branch still closes the task with the "check" kind.
    expect(h.find("task.completed")!.payload.taskKind).toBe("check");
  });

  it("uses the buildUsage override for the checker rawUsage when provided", async () => {
    const h = new StageHarness();
    await runCheckerStage({
      ...checkerArgs(h, passingCheck),
      buildUsage: ({ checkerTaskId, subtaskIndex }) => ({ custom: "c", checkerTaskId, subtaskIndex }),
    });
    expect(h.cost("task_check").rawUsage).toEqual({ custom: "c", checkerTaskId: "task_check", subtaskIndex: 0 });
  });
});

describe("runAuditorStage", () => {
  it("emits auditor.verdict and marks the audit passed on a pass decision", async () => {
    const h = new StageHarness();
    const { decision, auditorTaskId } = await runAuditorStage(auditorArgs(h, passingAudit));

    expect(decision.kind).toBe("pass");
    // The auditor task id is a generated `task_<uuid>` (not an empty string).
    expect(auditorTaskId).toMatch(/^task_[0-9a-f-]{36}$/);
    const verdict = h.find("auditor.verdict")!;
    expect(verdict.payload.passed).toBe(true);
    expect(verdict.payload.recommendedAction).toBe("pass");
    expect(verdict.payload.outstandingBehaviorIds).toEqual([]);
    expect(h.names()).not.toContain("auditor.rejected");
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("passed");

    // Insert metadata: an "audit plan" title under the planner, owned by the
    // answerer agent.
    const row = h.task(auditorTaskId);
    expect(row.title).toBe("audit plan");
    expect(row.kind).toBe("audit");
    expect(row.parentTaskId).toBe("task_plan");
    expect(row.agentKind).toBe("answerer");

    // task.started / auditor.started / task.completed carry the "audit" kind.
    expect(h.find("task.started")!.payload.taskKind).toBe("audit");
    expect(h.find("auditor.started")!.payload.taskKind).toBe("audit");
    expect(h.find("task.completed")!.payload.taskKind).toBe("audit");

    // Auditor cost: fixed model + default rawUsage role.
    const cost = h.cost(auditorTaskId);
    expect(cost.model).toBe("tanren-auditor");
    expect(cost.rawUsage).toEqual({ role: "auditor" });
  });

  it("emits auditor.rejected with the recommended action + outstanding ids on a non-pass decision", async () => {
    const h = new StageHarness();
    const { decision, auditorTaskId } = await runAuditorStage(auditorArgs(h, loopAudit));

    expect(decision.kind).not.toBe("pass");
    expect(h.names()).toContain("auditor.rejected");
    // The verdict event (before the decision branch) spreads the outstanding
    // behavior ids through — pins outstandingBehaviorIds: [...].
    const verdict = h.find("auditor.verdict")!;
    expect(verdict.payload.passed).toBe(false);
    expect(verdict.payload.outstandingBehaviorIds).toEqual(["B2"]);
    const rejected = h.find("auditor.rejected")!;
    expect(rejected.payload.recommendedAction).toBe("loop_to_planner");
    expect(rejected.payload.outstandingBehaviorIds).toEqual(["B2"]);
    expect(h.taskOutcomes.get(auditorTaskId)).toBe("rejected_by_auditor");
    // The reject-branch closes the auditor task with the "audit" kind.
    expect(h.find("task.completed")!.payload.taskKind).toBe("audit");
  });

  it("uses the buildUsage override for the auditor rawUsage when provided", async () => {
    const h = new StageHarness();
    const { auditorTaskId } = await runAuditorStage({
      ...auditorArgs(h, passingAudit),
      buildUsage: ({ auditorTaskId: id }) => ({ custom: "a", auditorTaskId: id }),
    });
    expect(h.cost(auditorTaskId).rawUsage).toEqual({ custom: "a", auditorTaskId });
  });
});
