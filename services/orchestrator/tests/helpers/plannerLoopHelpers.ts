// Test helpers shared by the P2A-0012 planner-loop test suites. Provides:
// - FakePool, a tiny pg substitute that captures task + cost inserts;
// - factories for in-memory planner / checker / auditor / writer adapters;
// - canned PlanAnswer / CheckAnswer / AuditAnswer fixtures;
// - defaultInput that wires the loop with a runnable single-subtask plan.
import type {
  AuditAnswer,
  CheckAnswer,
  PlanAnswer
} from "../../src/engine/answerers/schemas/index.js";
import { CostRecorder } from "../../src/engine/costs/index.js";
import { FakeEventStore } from "../../src/engine/eventStore.js";
import type {
  AnswererAdapter,
  AnswererRunOptions,
  WriterAdapter,
  WriterResult
} from "../../src/engine/providers/types.js";
import type { SubtaskLoopInput } from "../../src/engine/workflow/subtaskLoop.js";

interface FakePoolRecord {
  taskId: string;
  runId: string;
  kind: string;
  title: string;
  parentTaskId: string | null;
  status: string;
  outcome: string | null;
  cli: string;
}

export class FakePool {
  readonly tasks: FakePoolRecord[] = [];
  readonly costInserts: Array<{ taskId: string; cli: string }> = [];

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO tasks")) {
      if (trimmed.includes("parent_task_id")) {
        this.tasks.push({
          taskId: String(params[0]),
          runId: String(params[1]),
          kind: String(params[2]),
          title: String(params[3]),
          parentTaskId: params[4] === null ? null : String(params[4]),
          status: "running",
          outcome: null,
          cli: String(params[6])
        });
      } else {
        this.tasks.push({
          taskId: String(params[0]),
          runId: String(params[1]),
          kind: "plan",
          title: "plan spec",
          parentTaskId: null,
          status: "running",
          outcome: null,
          cli: String(params[2])
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE tasks SET status")) {
      const taskId = String(params[0]);
      const outcome = String(params[1]);
      const record = this.tasks.find((task) => task.taskId === taskId);
      if (record !== undefined) {
        record.status = "done";
        record.outcome = outcome;
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.costInserts.push({ taskId: String(params[0]), cli: String(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

export const fakeAuthRef = "credential/self-hosted/tanren-fake";

export function makePlanner(plans: ReadonlyArray<PlanAnswer>): AnswererAdapter<PlanAnswer> & { calls: AnswererRunOptions<PlanAnswer>[] } {
  let index = 0;
  const calls: AnswererRunOptions<PlanAnswer>[] = [];
  return {
    kind: "answerer", cli: "fake", authRef: fakeAuthRef, calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const plan = plans[index] ?? plans[plans.length - 1];
      index += 1;
      return plan;
    }
  };
}

export function makeChecker(verdicts: ReadonlyArray<CheckAnswer>): AnswererAdapter<CheckAnswer> & { calls: AnswererRunOptions<CheckAnswer>[] } {
  let index = 0;
  const calls: AnswererRunOptions<CheckAnswer>[] = [];
  return {
    kind: "answerer", cli: "fake", authRef: fakeAuthRef, calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const verdict = verdicts[index] ?? verdicts[verdicts.length - 1];
      index += 1;
      return verdict;
    }
  };
}

export function makeAuditor(verdicts: ReadonlyArray<AuditAnswer>): AnswererAdapter<AuditAnswer> & { calls: AnswererRunOptions<AuditAnswer>[] } {
  let index = 0;
  const calls: AnswererRunOptions<AuditAnswer>[] = [];
  return {
    kind: "answerer", cli: "fake", authRef: fakeAuthRef, calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const verdict = verdicts[index] ?? verdicts[verdicts.length - 1];
      index += 1;
      return verdict;
    }
  };
}

export function makeWriter(diffs: ReadonlyArray<string>): WriterAdapter & { calls: Array<{ prompt: string; workspace: string }> } {
  let index = 0;
  const calls: Array<{ prompt: string; workspace: string }> = [];
  return {
    kind: "writer", cli: "fake", authRef: fakeAuthRef, calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt, workspace: opts.workspace });
      const diff = diffs[index] ?? diffs[diffs.length - 1];
      index += 1;
      return {
        diff,
        commits: diff.length === 0 ? [] : [{ sha: `sha_${index}`, message: `subtask ${index}` }],
        exitReason: "completed",
        tokenUsage: { inputTokens: 1, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
        telemetry: { rawEventCount: 1 }
      };
    }
  };
}

export function buildPlan(subtasks: ReadonlyArray<{ title: string; intent: string; behaviorIds?: string[] }>): PlanAnswer {
  return {
    rationale: "decompose by behavior",
    subtasks: subtasks.map((s, index) => ({
      index,
      title: s.title,
      intent: s.intent,
      behaviorIds: s.behaviorIds ?? [],
      estimatedTokens: null
    }))
  };
}

export const passingCheck: CheckAnswer = {
  passed: true,
  reasoning: "diff satisfies the subtask intent",
  behaviorIdsPassed: ["B1"],
  behaviorIdsFailed: []
};

export const failingCheck: CheckAnswer = {
  passed: false,
  reasoning: "diff does not touch the required file",
  behaviorIdsPassed: [],
  behaviorIdsFailed: ["B1"]
};

export const passingAudit: AuditAnswer = {
  passed: true,
  reasoning: "every acceptance criterion is met",
  outstandingBehaviorIds: [],
  recommendedAction: "pass"
};

export const loopAudit: AuditAnswer = {
  passed: false,
  reasoning: "integrated result missed a behavior",
  outstandingBehaviorIds: ["B2"],
  recommendedAction: "loop_to_planner"
};

export const haltAudit: AuditAnswer = {
  passed: false,
  reasoning: "unrecoverable conflict between subtasks",
  outstandingBehaviorIds: ["B3"],
  recommendedAction: "halt"
};

export function defaultLoopInput(overrides: Partial<SubtaskLoopInput> = {}): { input: SubtaskLoopInput; pool: FakePool; events: FakeEventStore } {
  const pool = new FakePool();
  const events = new FakeEventStore();
  const recorder = new CostRecorder(pool, events);
  const input: SubtaskLoopInput = {
    pool,
    eventStore: events,
    recorder,
    adapters: {
      planner: makePlanner([buildPlan([{ title: "T1", intent: "Touch README", behaviorIds: ["B1"] }])]),
      writer: makeWriter(["diff --git README\n+ok\n"]),
      checker: makeChecker([passingCheck]),
      auditor: makeAuditor([passingAudit])
    },
    context: {
      runId: "run_test",
      specId: "spec_test",
      projectId: "project_test",
      specTitle: "Test spec",
      specDescription: "exercise the planner loop",
      acceptanceCriteria: ["README mentions ok"],
      behaviorIds: ["B1"],
      behaviorContext: [{ id: "B1", title: "README mentions ok", description: "the README contains the string ok" }],
      workspacePath: "/workspace/runs/run_test/repo"
    },
    escapeHatches: {
      maxPlannerRerunsPerSpec: 3,
      maxWriterIterPerSubtask: 5,
      maxRetriesPerTransientFailure: 3
    },
    timeoutMs: 1_000,
    ...overrides
  };
  return { input, pool, events };
}
