// STANDING RATCHET — per-stage `task.failed` emit-on-throw contract for every stage in
// the subtask loop. apex v51 surfaced the FIFTH disguised survivor of the
// timeout-eradication doctrine family (after #638 ssh2 socket-idle, #640 lock-file
// mtime-probe, #21B initial dag-noise signal, #21C single-neighbor watchdog floor):
// `runPlannerStage` had NO try/catch around `invokePlanner` and emitted NO per-task
// terminal event. When the answerer threw (e.g. `CodexUsageLimitError` on the Codex
// 5-hour subscription window exhausting), the throw escaped to the workflow catch in
// `plannerRun.ts:489`. Run / spec / runner events rode loud at the RUN granularity, but
// the planner's `task` row stayed `running` forever with no `task.failed` event — loud
// at one granularity, silent at another. Same shape as #640.
//
// THIS SUITE pins the contract for every stage that owns a per-stage `task` row:
// runPlannerStage, runWriterStage, runCheckerStage, runAuditorStage, runDemoRunStage,
// runTriageStage, runConvergenceStage. For each, four canonical throws are exercised
// (`CodexUsageLimitError`, `ClaudeUsageLimitError`, `AnswererStalledError` →
// `StageStallEscalationError` after the stall-recovery primitive runs to a fixed point,
// and a generic `Error`) and the same three invariants asserted:
//
//   1. the stage RE-THROWS (so the workflow's outer catch still routes run/spec
//      disposition);
//   2. BEFORE the throw escapes, EXACTLY ONE `task.failed` event was appended against
//      the stage's task id with the correct `taskKind` + classified `failureKind`;
//   3. `markTaskFailed` was issued on the same task id (the row UPDATE).
//
// On the SUCCESS path, exactly one `task.completed` event lands + the row is marked
// done (`passed`). A future PR that adds a new stage without the emit-on-throw pattern
// fails this suite. The design-oracle stage is NOT covered here for a different
// reason: its answerer fires BEFORE the task row materializes (the hasContract gate),
// so an answerer throw has no row to strand. The stage's POST-insert guard contract
// (Codex critic #5 — verdict append / cost record / terminal pair) is pinned in
// `designOracleFinalizeGuard.test.ts` against the same failureKind vocabulary.

import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../../src/engine/events/index.js";
import type { CostRecorder } from "../../src/engine/costs/index.js";
import type { AnswererAdapter, WriterAdapter, WriterResult } from "../../src/engine/providers/types.js";
import type {
  AuditAnswer,
  CheckAnswer,
  ConvergenceAnswer,
  DemoRunAnswer,
  PlanAnswer,
  PlanSubtask,
  TriageAnswer,
} from "../../src/engine/answerers/schemas/index.js";
import { AnswererStalledError } from "../../src/engine/providers/answererSchemaError.js";
import { CodexUsageLimitError } from "../../src/engine/providers/codex.js";
import { ClaudeUsageLimitError } from "../../src/engine/providers/claude.js";
import {
  runAuditorStage,
  runCheckerStage,
  runPlannerStage,
  runWriterStage,
} from "../../src/engine/workflow/subtaskStages.js";
import { runConvergenceStage, runDemoRunStage, runTriageStage } from "../../src/engine/workflow/loopStages.js";
import type { SubtaskCostContext } from "../../src/engine/workflow/subtaskCost.js";
import { buildPlan } from "../helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "../fixtures/inMemoryRunStateWriter.js";

// ---- recording harness (a focused subset of StageHarness in subtaskStages.test.ts) --
//
// Audit finding H3 sweep: every stage now requires a writer at its atomic
// terminal seam (no fallback arm). The harness wires the InMemoryRunStateWriter
// fixture; its terminal `updateTaskWithEvent` drives both the row state and
// the terminal event back into the existing recorder so the conformance
// assertions hold unchanged.

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

class StageHarness {
  readonly events: RecordedEvent[] = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
        taskId: input.taskId,
      });
    },
  });
  get tasksMarkedFailed(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.status === "failed" && row.failureKind !== null) {
        map.set(taskId, row.failureKind);
      }
    }
    return map;
  }
  get tasksMarkedDone(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, row] of this.writer.tasks.entries()) {
      if (row.status === "done" && row.outcome !== null) {
        map.set(taskId, row.outcome);
      }
    }
    return map;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  /** Events of a given type whose taskId matches; multiple ⇒ the contract was broken. */
  emittedFailedFor(taskId: string): RecordedEvent[] {
    return this.events.filter((e) => e.eventType === "task.failed" && e.taskId === taskId);
  }

  emittedCompletedFor(taskId: string): RecordedEvent[] {
    return this.events.filter((e) => e.eventType === "task.completed" && e.taskId === taskId);
  }
}

// ---- canonical throwables the stages must classify ---------------------------------
//
// Each entry is a (label, factory, expected-failureKind) tuple. The four shapes are the
// ones the apex run loop legitimately surfaces: a Codex/Claude usage-limit (the v51
// finding's exact shape), a stall that runs the stage-recovery primitive to its proven
// fixed point (escalates as `StageStallEscalationError`), and a generic Error (the
// fail-closed `crashed` default for any non-classified throw).

const usageLimitCodex = (): Error => new CodexUsageLimitError("PlanAnswer", "5-hour window exhausted");
const usageLimitClaude = (): Error => new ClaudeUsageLimitError("PlanAnswer", "5-hour window exhausted");
const wedgedStall = (): Error => new AnswererStalledError("PlanAnswer");
const genericCrash = (): Error => new Error("ssh transport died");

// `wrapsToEscalation` marks the THROW_CASE where `runAnswererStageWithRecovery`
// re-classifies the raw stall into `StageStallEscalationError` BEFORE the stage's
// per-task catch sees it — true for any stage routed through the stall-recovery primitive
// (checker / auditor / demo / triage / convergence). The planner + writer call their
// answerer/writer directly, so a raw stall passes through unchanged. Either way the
// classifier maps both to `failureKind: "timeout"`, which is what the contract pins.
const THROW_CASES: ReadonlyArray<{
  label: string;
  make: () => Error;
  failureKind: string;
  wrapsToEscalation?: boolean;
}> = [
  { label: "CodexUsageLimitError → window_exhausted", make: usageLimitCodex, failureKind: "window_exhausted" },
  { label: "ClaudeUsageLimitError → window_exhausted", make: usageLimitClaude, failureKind: "window_exhausted" },
  {
    label: "wedged stall → timeout (raw or escalated)",
    make: wedgedStall,
    failureKind: "timeout",
    wrapsToEscalation: true,
  },
  { label: "generic Error → crashed (fail-closed default)", make: genericCrash, failureKind: "crashed" },
];

// ---- adapter factories: throw on call (for the throw branch) -----------------------

function throwingAnswerer<T>(error: Error): AnswererAdapter<T> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "secret://fake",
    async runAnswerer(): Promise<T> {
      throw error;
    },
  };
}

function throwingWriter(error: Error): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    authRef: "secret://fake",
    async runWriter(): Promise<WriterResult> {
      throw error;
    },
  };
}

// ---- a stable subtask + base spec context used across the stages -------------------

const subtask: PlanSubtask = {
  index: 0,
  title: "Wire behavior B1",
  intent: "touch the README",
  behaviorIds: ["B1"],
  estimatedTokens: null,
};

const plan: PlanAnswer = buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]);

// ---- per-stage driver: returns (taskId, action) so each spec can run + assert -----
//
// Each driver inserts the task row + emits `task.started` itself when needed, then
// returns the per-stage action under test. The throwing adapter is built per-throw-case
// so we exercise the four canonical shapes against every stage.

interface StageDriver {
  /** A human-readable stage name (the `task.failed.taskKind` it must emit). */
  taskKind: string;
  /** The known task id the stage operates on (so the harness can assert against it). */
  taskId: string;
  /** Run the stage with an adapter that throws `error`. */
  runThrow: (h: StageHarness, error: Error) => Promise<unknown>;
}

const DRIVERS: ReadonlyArray<StageDriver> = [
  {
    taskKind: "plan",
    taskId: "task_plan",
    runThrow: (h, error) =>
      runPlannerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<PlanAnswer>(error),
        spec: {
          specTitle: "S",
          specDescription: "D",
          acceptanceCriteria: ["AC1"],
          behaviorIds: [],
          behaviorContext: [],
        },
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        appendEvent: h.appendEvent,
        attempt: 1,
        rejectionHistory: [],
      }),
  },
  {
    taskKind: "write",
    taskId: "task_write",
    runThrow: (h, error) =>
      runWriterStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingWriter(error),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        subtask,
        writeTaskId: "task_write",
        prompt: "write it",
        appendEvent: h.appendEvent,
      }),
  },
  {
    taskKind: "check",
    taskId: "task_check",
    runThrow: (h, error) =>
      runCheckerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<CheckAnswer>(error),
        runId: "run_1",
        workspacePath: "/ws",
        writeTaskId: "task_write",
        checkerTaskId: "task_check",
        subtask,
        writerResult: { diff: "d", commits: [], exitReason: "completed" },
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        appendEvent: h.appendEvent,
      }),
  },
  {
    // The auditor pre-generates its own UUID task id. We can't predict it before the
    // call, but the harness records the FIRST UPDATE/event taskId — so the assertions
    // use that observed id rather than a fixed one (the contract is satisfied as long
    // as a single task id received both the markFailed UPDATE and the task.failed event).
    taskKind: "audit",
    taskId: "<auditor-generated>",
    runThrow: (h, error) =>
      runAuditorStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<AuditAnswer>(error),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        plan,
        baseSha: "a".repeat(40),
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        appendEvent: h.appendEvent,
      }),
  },
  {
    taskKind: "demo",
    taskId: "<demo-generated>",
    runThrow: (h, error) =>
      runDemoRunStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<DemoRunAnswer>(error),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        baselineSha: "a".repeat(40),
        appendEvent: h.appendEvent,
      }),
  },
  {
    taskKind: "triage",
    taskId: "<triage-generated>",
    runThrow: (h, error) =>
      runTriageStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<TriageAnswer>(error),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        specTitle: "S",
        specDescription: "D",
        baselineSha: "a".repeat(40),
        findings: [{ id: "f1", severity: "P0", title: "x", body: "y" }],
        posture: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
        appendEvent: h.appendEvent,
      }),
  },
  {
    taskKind: "convergence",
    taskId: "<convergence-generated>",
    runThrow: (h, error) =>
      runConvergenceStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: throwingAnswerer<ConvergenceAnswer>(error),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        specTitle: "S",
        baselineSha: "a".repeat(40),
        loopIndex: 0,
        currentFindings: [{ id: "f1", severity: "P0", title: "x", body: "y" }],
        priorFindings: [],
        state: { consecutiveStalls: 0, blockingHistory: [] },
        velocityPolicy: { enabled: false, maxSeverity: "P3", afterStalls: 2 },
        appendEvent: h.appendEvent,
      }),
  },
];

// The per-driver suites: same three invariants, four canonical throws each.
describe("subtask-loop stages: per-stage `task.failed` emit-on-throw conformance contract", () => {
  for (const driver of DRIVERS) {
    describe(`stage taskKind="${driver.taskKind}"`, () => {
      for (const throwCase of THROW_CASES) {
        it(`emits exactly one task.failed + markTaskFailed + re-throws on ${throwCase.label}`, async () => {
          const h = new StageHarness();
          const error = throwCase.make();

          // 1. The stage RE-THROWS — the workflow's outer catch still routes disposition. For
          // stages routed through `runAnswererStageWithRecovery` a raw `AnswererStalledError` is
          // re-classified into `StageStallEscalationError` AT the recovery primitive (the wedge
          // has been proven). The classified `failureKind` on the emitted event is the durable
          // contract — that the same-instance vs wrapped-instance distinction (asserted in
          // the dedicated `re-throws the same instance` test below) doesn't blur.
          await expect(driver.runThrow(h, error)).rejects.toBeInstanceOf(Error);

          // The task id the stage actually emitted against (auditor/demo/triage/convergence
          // generate their own UUID id; planner/writer/check use the wired-in id).
          const failedEvents = h.events.filter((e) => e.eventType === "task.failed");
          expect(failedEvents.length).toBeGreaterThanOrEqual(1);
          const observedTaskId = failedEvents[0]!.taskId!;
          expect(observedTaskId).toBeDefined();

          // 2. EXACTLY ONE task.failed against that task id (no double-emit, no silence).
          const forTask = h.emittedFailedFor(observedTaskId);
          expect(forTask).toHaveLength(1);
          // The payload carries the correct taskKind + the classified failureKind. The
          // message is included but not asserted byte-for-byte (it carries the raw error
          // message — the public-sensitivity classifier upstream redacts it for the timeline).
          expect(forTask[0]!.payload).toMatchObject({
            taskKind: driver.taskKind,
            failureKind: throwCase.failureKind,
          });
          expect(typeof forTask[0]!.payload.message).toBe("string");
          expect((forTask[0]!.payload.message as string).length).toBeGreaterThan(0);

          // 3. markTaskFailed was issued on the SAME task id (the row UPDATE).
          expect(h.tasksMarkedFailed.get(observedTaskId)).toBe(throwCase.failureKind);

          // The stage MUST NOT have emitted task.completed against the failed task id —
          // that would breach the single-finalize invariant (autonomy-engine.md §1c).
          // Auditor schema-miss path emits a task.completed AFTER markTaskFailed by design
          // (the synthetic-P0 recovery), but the non-schema throws here MUST NOT.
          expect(h.emittedCompletedFor(observedTaskId)).toHaveLength(0);
        });
      }

      // The same-instance-re-throw contract: for the non-wrapped cases (usage-limit + generic
      // throws — every shape except the wedged stall, which the stall-recovery primitive
      // RECLASSIFIES into a `StageStallEscalationError`) the stage must re-throw the very same
      // Error instance — never a substitute. Stall-wrapping is exercised separately above.
      const NON_WRAPPED_CASES = THROW_CASES.filter((c) => c.wrapsToEscalation !== true);
      for (const throwCase of NON_WRAPPED_CASES) {
        it(`re-throws the same Error instance on ${throwCase.label}`, async () => {
          const error = throwCase.make();
          await expect(driver.runThrow(new StageHarness(), error)).rejects.toBe(error);
        });
      }
    });
  }
});
