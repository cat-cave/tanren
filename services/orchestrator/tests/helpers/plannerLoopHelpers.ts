// Test helpers shared by the spec-loop test suites (docs/roadmap/spec-loop-redesign.md).
// Provides:
// - FakePool, a tiny pg substitute that captures task + cost inserts;
// - factories for in-memory planner / checker / auditor / triage / convergence /
//   demo-run / writer adapters;
// - canned PlanAnswer / CheckAnswer / AuditAnswer / TriageAnswer / ConvergenceAnswer /
//   DemoRunAnswer fixtures (the new findings-only contracts);
// - defaultLoopInput that wires the loop with a runnable single-subtask plan.
import type {
  AuditAnswer,
  CheckAnswer,
  ConvergenceAnswer,
  DemoRunAnswer,
  DesignOracleAnswer,
  PlanAnswer,
  TriageAnswer,
} from "../../src/engine/answerers/schemas/index.js";
import type { CiWhen } from "../../src/engine/ci/index.js";
import { AnswererStalledError } from "../../src/engine/providers/answererSchemaError.js";
import { CostRecorder } from "../../src/engine/costs/index.js";
import type { GateOutcome } from "../../src/engine/workflow/gate/index.js";
import { FakeEventStore } from "./fakeEventStore.js";
import type {
  AnswererAdapter,
  AnswererRunOptions,
  WriterAdapter,
  WriterResult,
} from "../../src/engine/providers/types.js";
import type { SubtaskLoopInput } from "../../src/engine/workflow/subtaskLoop.js";
import { buildLoopWriter } from "./plannerLoopWriter.js";

interface FakePoolRecord {
  taskId: string;
  runId: string;
  kind: string;
  title: string;
  parentTaskId: string | null;
  status: string;
  outcome: string | null;
  failureKind: string | null;
  cli: string;
}

export class FakePool {
  readonly tasks: FakePoolRecord[] = [];
  readonly costInserts: Array<{ taskId: string; cli: string }> = [];
  readonly costRows: Array<{ id: string; totalTokens: number; billingMode: string }> = [];
  readonly costUpdates: Array<{ id: string; costUsd: string; basis: string | null }> = [];
  readonly notionalUpdates: Array<{ id: string; notionalCostUsd: string; basis: string | null }> = [];
  // §3.7f: the auth_ref values stamped on runs, and the count the concurrency query
  // reports back (default 1 — a lone run, byte-identical to the pre-fix behavior).
  readonly runsAuthRefStamps: Array<{ runId: string; authRef: string }> = [];
  concurrentRunsOnCredential = 1;
  private nextCostId = 1;

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("UPDATE runs SET auth_ref")) {
      this.runsAuthRefStamps.push({ runId: String(params[0]), authRef: String(params[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT count(*)::text AS n FROM runs")) {
      return { rows: [{ n: String(this.concurrentRunsOnCredential) }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT id, total_tokens, billing_mode FROM cost_records")) {
      return {
        rows: this.costRows.map((row) => ({
          id: row.id,
          total_tokens: row.totalTokens,
          billing_mode: row.billingMode,
        })),
        rowCount: this.costRows.length,
      };
    }
    if (trimmed.startsWith("UPDATE cost_records SET")) {
      const basis = params[2] === undefined ? null : String(params[2]);
      if (trimmed.includes("SET cost_usd = $2")) {
        this.costUpdates.push({ id: String(params[0]), costUsd: String(params[1]), basis });
      }
      if (trimmed.includes("notional_cost_usd = $2")) {
        this.notionalUpdates.push({ id: String(params[0]), notionalCostUsd: String(params[1]), basis });
      }
      return { rows: [], rowCount: 1 };
    }
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
          failureKind: null,
          cli: String(params[6]),
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
          failureKind: null,
          cli: String(params[2]),
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE tasks SET status = 'failed'")) {
      const taskId = String(params[0]);
      const failureKind = String(params[1]);
      const record = this.tasks.find((task) => task.taskId === taskId);
      if (record !== undefined) {
        record.status = "failed";
        record.outcome = "failed";
        record.failureKind = failureKind;
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
      this.costRows.push({
        id: String(this.nextCostId++),
        totalTokens: Number(params[11] ?? 0),
        billingMode: String(params[14] ?? "self_hosted"),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

export const fakeAuthRef = "credential/self-hosted/tanren-fake";

function makeAnswerer<T>(answers: ReadonlyArray<T>): AnswererAdapter<T> & { calls: AnswererRunOptions<T>[] } {
  let index = 0;
  const calls: AnswererRunOptions<T>[] = [];
  return {
    kind: "answerer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const answer = answers[index] ?? answers.at(-1);
      index += 1;
      return answer as T;
    },
  };
}

// An answerer that STALLS (throws `AnswererStalledError`) for its first `stallsBefore`
// calls, then returns `answer` — the transient-stall shape the loop-stage recovery wrapper
// re-drives through. `stallsBefore: Infinity` makes it a GENUINELY-WEDGED stage (stalls on
// every call) so the convergence judgment escalates. Records its calls like makeAnswerer.
export function makeStallingThenAnswer<T>(
  answer: T,
  stallsBefore: number,
): AnswererAdapter<T> & { calls: AnswererRunOptions<T>[] } {
  let index = 0;
  const calls: AnswererRunOptions<T>[] = [];
  return {
    kind: "answerer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const stalling = index < stallsBefore;
      index += 1;
      if (stalling) throw new AnswererStalledError("FakeAnswer");
      return answer;
    },
  };
}

export const makePlanner = (plans: ReadonlyArray<PlanAnswer>) => makeAnswerer<PlanAnswer>(plans);
export const makeChecker = (verdicts: ReadonlyArray<CheckAnswer>) => makeAnswerer<CheckAnswer>(verdicts);
export const makeAuditor = (verdicts: ReadonlyArray<AuditAnswer>) => makeAnswerer<AuditAnswer>(verdicts);
export const makeConvergence = (answers: ReadonlyArray<ConvergenceAnswer>) => makeAnswerer<ConvergenceAnswer>(answers);
export const makeDemoRun = (answers: ReadonlyArray<DemoRunAnswer>) => makeAnswerer<DemoRunAnswer>(answers);
export const makeDesignOracle = (answers: ReadonlyArray<DesignOracleAnswer>) =>
  makeAnswerer<DesignOracleAnswer>(answers);

// makeTriage — see `./makeTriage.ts` (extracted to hold this file's 500-line cap).
import { makeTriage } from "./makeTriage.js";
export { makeTriage };

export function makeWriter(
  diffs: ReadonlyArray<string>,
): WriterAdapter & { calls: Array<{ prompt: string; workspace: string }> } {
  let index = 0;
  const calls: Array<{ prompt: string; workspace: string }> = [];
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt, workspace: opts.workspace });
      const diff = diffs[index] ?? diffs.at(-1) ?? "";
      index += 1;
      return {
        diff,
        commits: diff.length === 0 ? [] : [{ sha: `sha_${index}`, message: `subtask ${index}` }],
        exitReason: "completed",
        tokenUsage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
        },
        telemetry: { rawEventCount: 1 },
      };
    },
  };
}

// A writer that returns a single result with a non-`completed` exitReason.
export function makeFailingWriter(
  exitReason: WriterResult["exitReason"],
): WriterAdapter & { calls: Array<{ prompt: string; workspace: string }> } {
  const calls: Array<{ prompt: string; workspace: string }> = [];
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt, workspace: opts.workspace });
      return {
        diff: "",
        commits: [],
        exitReason,
        tokenUsage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 1,
        },
        telemetry: { rawEventCount: 1 },
      };
    },
  };
}

// A writer driven by a per-CALL script of outcomes (diff + exitReason). Lets a test
// assert the inner loop's behavior ACROSS attempts — e.g. a 1st-call TIMEOUT followed by a
// 2nd-call completion, checking that the 2nd writer prompt carries CHANGED steering (the
// apex-v36 "don't re-run the identical subtask to another timeout" fix). An absent entry
// falls back to the last. Records every prompt so the test inspects the rework steering.
export function makeScriptedWriter(
  script: ReadonlyArray<{ diff: string; exitReason: WriterResult["exitReason"] }>,
): WriterAdapter & { calls: Array<{ prompt: string; workspace: string }> } {
  let index = 0;
  const calls: Array<{ prompt: string; workspace: string }> = [];
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runWriter(opts): Promise<WriterResult> {
      calls.push({ prompt: opts.prompt, workspace: opts.workspace });
      const entry = script[index] ?? script.at(-1) ?? { diff: "", exitReason: "completed" };
      index += 1;
      return {
        diff: entry.diff,
        commits: entry.diff.length === 0 ? [] : [{ sha: `sha_${index}`, message: `subtask ${index}` }],
        exitReason: entry.exitReason,
        tokenUsage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 1,
          reasoningOutputTokens: 0,
          totalTokens: 2,
        },
        telemetry: { rawEventCount: 1 },
      };
    },
  };
}

// A deterministic gate stub. `results` is the per-CALL pass/fail sequence; an absent
// entry falls back to the last. Records every call so tests assert ordering (the fast
// gate runs BEFORE the checker).
export function makeGate(results: ReadonlyArray<{ passed: boolean }>): {
  gate: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  calls: Array<{ when: CiWhen }>;
} {
  let index = 0;
  const calls: Array<{ when: CiWhen }> = [];
  const gate = async (input: { when: CiWhen; taskId?: string }): Promise<GateOutcome> => {
    calls.push({ when: input.when });
    const entry = results[index] ?? results.at(-1) ?? { passed: true };
    index += 1;
    if (entry.passed) {
      return { passed: true, results: [] };
    }
    return {
      passed: false,
      results: [],
      failure: {
        passed: false,
        tier: "fast",
        when: input.when,
        failedStep: "typecheck",
        exitCode: 1,
        steps: [],
      },
    };
  };
  return { gate, calls };
}

export function buildPlan(
  subtasks: ReadonlyArray<{ title: string; intent: string; behaviorIds?: string[] }>,
): PlanAnswer {
  return {
    rationale: "decompose by behavior",
    subtasks: subtasks.map((s, index) => ({
      index,
      title: s.title,
      intent: s.intent,
      behaviorIds: s.behaviorIds ?? [],
      estimatedTokens: null,
    })),
  };
}

// ---- CHECKER fixtures (completeness findings only) ------------------------

// A complete task: an EXPLICIT empty findings list.
export const completeCheck: CheckAnswer = {
  findings: [],
  reasoning: "the change delivers the subtask intent for downstream needs",
};

// An incomplete task: a P0 completeness finding ⇒ back to the writer.
export const incompleteCheck: CheckAnswer = {
  findings: [
    { id: "missing-file", title: "required file not created", body: "downstream tasks import it", behaviorId: "B1" },
  ],
  reasoning: "the change does not touch the required file",
};

// ---- AUDITOR fixtures (findings only) -------------------------------------

// Audited-clean: an EXPLICIT empty findings list.
export const cleanAudit: AuditAnswer = { findings: [] };

// A blocking P1 finding.
export const p1Audit: AuditAnswer = {
  findings: [{ id: "missed-behavior-B2", severity: "P1", title: "B2 not implemented", body: "B2 is uncovered." }],
};

// An irrecoverable P0 finding.
export const p0Audit: AuditAnswer = {
  findings: [
    { id: "subtask-conflict", severity: "P0", title: "Unrecoverable subtask conflict", body: "B3 conflicts." },
  ],
};

// A P2-only (non-blocking) finding.
export const p2Audit: AuditAnswer = {
  findings: [{ id: "polish-1", severity: "P2", title: "rename a var", body: "minor" }],
};

// ---- TRIAGE fixtures ------------------------------------------------------
// NOTE: `makeTriage` above auto-extends each returned workItem's `findingIds` with
// the input finding ids from the prompt, so shared fixtures don't need to hardcode
// them (coverage-guard is satisfied dynamically). The ["f1"] below is a legibility marker.

// Route every finding to a TASK in this spec (the loop then runs convergence).
export const triageAllTasks: TriageAnswer = {
  workItems: [
    { id: "wi-1", kind: "task", severity: "P0", title: "fix the gap", body: "implement it", findingIds: ["f1"] },
  ],
};

// Like triageAllTasks but the kept item is a MILD (P3) leftover — the realistic
// "only P3 left after several rounds" shape the velocity-defer policy may defer.
export const triageMildTasks: TriageAnswer = {
  workItems: [{ id: "wi-mild", kind: "task", severity: "P3", title: "tidy later", body: "a nit", findingIds: ["f1"] }],
};

// Route every finding to a NEW SPEC (P3 leftover ⇒ velocity); the loop PASSES.
export const triageAllSpecs: TriageAnswer = {
  workItems: [
    { id: "wi-spec", kind: "spec", severity: "P3", title: "polish later", body: "a follow-up", findingIds: ["f1"] },
  ],
};

// ---- CONVERGENCE fixtures -------------------------------------------------

export const convergenceProgress: ConvergenceAnswer = {
  assessment: "progress",
  blockingRootCauseId: "blocker-a",
  blockingRootCauseProgress: "retired",
  escalation: "keep_going",
  escalationReason: "",
  reasoning: "fewer findings than last loop; the blocking root cause was retired",
};
// A STALLED read where the agent judges a human IS needed (a genuine dead-end) → escalate.
export const convergenceStalled: ConvergenceAnswer = {
  assessment: "stalled",
  blockingRootCauseId: "blocker-a",
  blockingRootCauseProgress: "unchanged",
  escalation: "escalate",
  escalationReason: "the blocking root cause cannot be resolved without a product decision",
  reasoning: "same blocking root cause recurs unchanged",
};
// A STALLED read where the agent judges the loop should KEEP GOING (slow/hard, a new approach).
export const convergenceStalledKeepGoing: ConvergenceAnswer = {
  assessment: "stalled",
  blockingRootCauseId: "blocker-a",
  blockingRootCauseProgress: "unchanged",
  escalation: "keep_going",
  escalationReason: "",
  reasoning: "slow but a different approach is worth trying",
};
export const convergenceVelocity: ConvergenceAnswer = {
  assessment: "velocity_defer",
  blockingRootCauseId: "",
  blockingRootCauseProgress: "none",
  escalation: "keep_going",
  escalationReason: "",
  reasoning: "only P3 left after several rounds; no blocking finding remains",
};

// ---- DEMO-RUN fixtures ----------------------------------------------------

export const demoClean: DemoRunAnswer = { findings: [], summary: "exercised the create+read flow successfully" };
export const demoBroken: DemoRunAnswer = {
  findings: [{ id: "create-fails", severity: "P0", title: "create endpoint 500s", body: "POST /x returns 500" }],
  summary: "tried the create flow; it failed",
};

export function defaultLoopInput(overrides: Partial<SubtaskLoopInput> = {}): {
  input: SubtaskLoopInput;
  pool: FakePool;
  events: FakeEventStore;
} {
  const pool = new FakePool();
  const events = new FakeEventStore();
  const writer = buildLoopWriter(pool, events);
  const recorder = new CostRecorder(pool, events);
  const input: SubtaskLoopInput = {
    pool,
    eventStore: events,
    runStateWriter: writer,
    recorder,
    adapters: {
      planner: makePlanner([buildPlan([{ title: "T1", intent: "Touch README", behaviorIds: ["B1"] }])]),
      writer: makeWriter(["diff --git README\n+ok\n"]),
      checker: makeChecker([completeCheck]),
      auditor: makeAuditor([cleanAudit]),
      triage: makeTriage([triageAllTasks]),
      convergence: makeConvergence([convergenceProgress]),
      demoRun: makeDemoRun([demoClean]),
      designOracle: makeDesignOracle([]),
    },
    context: {
      runId: "run_test",
      specId: "spec_test",
      projectId: "project_test",
      orgId: "org_test",
      specTitle: "Test spec",
      specDescription: "exercise the spec loop",
      acceptanceCriteria: ["README mentions ok"],
      behaviorIds: ["B1"],
      behaviorContext: [{ id: "B1", title: "README mentions ok", description: "the README contains the string ok" }],
      workspacePath: "/workspace/runs/run_test/repo",
    },
    timeoutMs: 1_000,
    ...overrides,
  };
  return { input, pool, events };
}
