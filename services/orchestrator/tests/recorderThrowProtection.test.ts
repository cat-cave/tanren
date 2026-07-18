// task #35 (critic-arc R1 #6 / R2) — WIDER finalize-guard contract
//
// PR #665 (apex v51) added `runStageWithEmitOnThrow` around each stage's
// PROVIDER body. That wrap did NOT cover the POST-call cost-record + terminal
// row/event sites — so a `recordWriterCost` / `recordAnswererCost` throw (the
// recorder's DB INSERT at `recorder.ts:170` failing under transport / RLS /
// schema drift) left the task row stranded `running` forever with no
// `task.failed` event. THIS PR widens the guard
// (`runStageBodyWithFinalizeGuard`) over the whole post-insert body —
// provider call + cost record + terminal row + terminal event — so a throw
// ANYWHERE in that chain closes the row loud + emits exactly one `task.failed`
// with a deterministic `failureKind`:
//
//   - `CostRecordError` → `failureKind: "cost_record_failed"`
//   - `EventAppendError` → `failureKind: "event_append_failed"` (PRE-TERMINAL)
//
// This suite exercises BOTH fault shapes against every stage that owns a
// per-stage `task` row (`runPlannerStage`, `runWriterStage`, `runCheckerStage`,
// `runAuditorStage`, `runDemoRunStage`, `runTriageStage`, `runConvergenceStage`).
// The per-stage emit-on-throw conformance for the PROVIDER throw (PR #665
// shape) is the standing ratchet in `tests/conformance/subtaskLoopStages.test.ts`;
// this file is the post-provider companion. Together they pin the
// single-finalize invariant (`autonomy-engine.md` §1c): every task row reaches
// a terminal state with exactly one terminal `task.*` event.
//
// The design-oracle stage's WIDER-guard contract is pinned in the sibling
// `designOracleFinalizeGuard.test.ts` (Codex critic #5 — the stage's task row
// materializes only after the `hasContract` gate, so its harness needs the
// design_contracts + personas + behaviors read wiring; the two fault shapes
// exercised here are covered there against the same guard invariants).

import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { AnswererAdapter, TokenUsage, WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import type {
  AuditAnswer,
  CheckAnswer,
  ConvergenceAnswer,
  DemoRunAnswer,
  PlanAnswer,
  PlanSubtask,
  TriageAnswer,
} from "../src/engine/answerers/schemas/index.js";
import {
  runAuditorStage,
  runCheckerStage,
  runPlannerStage,
  runWriterStage,
} from "../src/engine/workflow/subtaskStages.js";
import { runConvergenceStage, runDemoRunStage, runTriageStage } from "../src/engine/workflow/loopStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { buildPlan } from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
  taskId: string | undefined;
}

// A focused harness: the only knobs are the two task #35 fault shapes (recorder
// throws + a chosen pre-terminal event-append throws). The writer is required
// at the atomic terminal seam (audit finding H3 sweep) — the fixture forwards
// its events back into `events` AND honors `throwOnEventTypes` so a forced
// throw on a terminal `task.*` event surfaces through the seam just like the
// pre-terminal `appendEvent` path.
class GuardHarness {
  readonly events: RecordedEvent[] = [];
  throwOnEventTypes: ReadonlySet<EventName> = new Set();
  recorderThrows = false;
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      if (this.throwOnEventTypes.has(input.eventType as EventName)) {
        throw new Error(`event-append transport failure: ${input.eventType}`);
      }
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
        taskId: input.taskId,
      });
    },
  });
  // Derived from the writer's row state — replaces the prior SQL-stub maps.
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
    if (this.throwOnEventTypes.has(eventType)) {
      throw new Error(`event-append transport failure: ${eventType}`);
    }
    this.events.push({ eventType, payload: payload as Record<string, unknown>, taskId });
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async () => {
        if (this.recorderThrows) {
          throw new Error("cost recorder DB INSERT failed (pg transport / RLS / schema)");
        }
        return undefined as never;
      },
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1", orgId: "org_1" };
  }
}

// --- successful adapters / fixtures (the post-provider path is what we want to drive) ---

const tokens: TokenUsage = {
  inputTokens: 1,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1,
  reasoningOutputTokens: 0,
  totalTokens: 2,
};

function successAnswerer<T>(value: T): AnswererAdapter<T> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "secret://fake",
    async runAnswerer(): Promise<T> {
      return value;
    },
    lastTokenUsage: () => tokens,
  };
}

function successWriter(result: WriterResult): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    authRef: "secret://fake",
    async runWriter(): Promise<WriterResult> {
      return result;
    },
  };
}

const subtask: PlanSubtask = {
  index: 0,
  title: "exercise the guard",
  intent: "drive the post-provider path",
  behaviorIds: ["B1"],
  estimatedTokens: null,
};

const planSuccess: PlanAnswer = buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }]);
const checkSuccess: CheckAnswer = { findings: [], reasoning: "ok" };
const auditSuccess: AuditAnswer = { findings: [] };
const demoSuccess: DemoRunAnswer = { summary: "ok", findings: [] };
const triageSuccess: TriageAnswer = { workItems: [] };
const convergenceSuccess: ConvergenceAnswer = {
  assessment: "complete",
  blockingRootCauseProgress: "retired",
  blockingRootCauseId: "rc1",
  escalation: "continue",
  escalationReason: "",
  reasoning: "ok",
};
const writerSuccess: WriterResult = {
  diff: "diff --git a/x b/x",
  commits: [],
  exitReason: "completed",
  tokenUsage: tokens,
};

// Each driver runs ONE stage with a SUCCESSFUL provider/adapter call. The
// `preTerminalEvent` is the stage's first PRE-TERMINAL `wrapEventAppend`-guarded
// emit (a throw at the post-terminal `task.completed` is the guard's idempotent
// catch — the row may already be `done`; we test the pre-terminal case here).
interface Driver {
  taskKind: string;
  /** The stage's task id — auditor/demo/triage/convergence pre-generate UUIDs;
   *  those drivers leave this undefined and the test resolves the observed id
   *  from the recorded `task.failed` event. */
  taskId?: string;
  preTerminalEvent: EventName;
  runSuccess: (h: GuardHarness) => Promise<unknown>;
}

const DRIVERS: ReadonlyArray<Driver> = [
  {
    taskKind: "plan",
    taskId: "task_plan",
    preTerminalEvent: "planner.subtasks.emitted",
    runSuccess: (h) =>
      runPlannerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<PlanAnswer>(planSuccess),
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
    preTerminalEvent: "writer.subtask.completed",
    runSuccess: (h) =>
      runWriterStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successWriter(writerSuccess),
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
    preTerminalEvent: "checker.verdict",
    runSuccess: (h) =>
      runCheckerStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<CheckAnswer>(checkSuccess),
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
    taskKind: "audit",
    preTerminalEvent: "auditor.verdict",
    runSuccess: (h) =>
      runAuditorStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<AuditAnswer>(auditSuccess),
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        plan: planSuccess,
        baseSha: "a".repeat(40),
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        appendEvent: h.appendEvent,
      }),
  },
  {
    taskKind: "demo",
    preTerminalEvent: "demoRun.verdict",
    runSuccess: (h) =>
      runDemoRunStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<DemoRunAnswer>(demoSuccess),
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
    preTerminalEvent: "triage.completed",
    runSuccess: (h) =>
      runTriageStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<TriageAnswer>(triageSuccess),
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
    preTerminalEvent: "convergence.assessed",
    runSuccess: (h) =>
      runConvergenceStage({
        pool: { query: h.query },
        writer: h.writer,
        costCtx: h.costCtx(),
        adapter: successAnswerer<ConvergenceAnswer>(convergenceSuccess),
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

function assertGuardCaught(h: GuardHarness, driver: Driver, expectedKind: string): void {
  const failedEvents = h.events.filter((e) => e.eventType === "task.failed");
  expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  const observedTaskId = driver.taskId ?? failedEvents[0]!.taskId!;
  expect(observedTaskId).toBeDefined();

  const forTask = failedEvents.filter((e) => e.taskId === observedTaskId);
  expect(forTask).toHaveLength(1);
  expect(forTask[0]!.payload).toMatchObject({
    taskKind: driver.taskKind,
    failureKind: expectedKind,
  });
  expect(typeof forTask[0]!.payload.message).toBe("string");

  // The row UPDATE landed `failed` with the deterministic kind (NOT `crashed`).
  expect(h.tasksMarkedFailed.get(observedTaskId)).toBe(expectedKind);

  // No clean-branch `task.completed` for the failed task id — the single-finalize
  // invariant (autonomy-engine.md §1c).
  const completed = h.events.filter((e) => e.eventType === "task.completed" && e.taskId === observedTaskId);
  expect(completed).toHaveLength(0);
}

describe("subtask-loop stages: WIDER finalize-guard contract for mid-stage failures (task #35)", () => {
  for (const driver of DRIVERS) {
    describe(`stage taskKind="${driver.taskKind}"`, () => {
      it("a cost-recorder throw after a successful provider call ⇒ failureKind: cost_record_failed + one task.failed + re-throws", async () => {
        const h = new GuardHarness();
        h.recorderThrows = true;
        await expect(driver.runSuccess(h)).rejects.toBeInstanceOf(Error);
        assertGuardCaught(h, driver, "cost_record_failed");
      });

      it(`a throw on the pre-terminal '${driver.preTerminalEvent}' event ⇒ failureKind: event_append_failed + one task.failed + re-throws`, async () => {
        const h = new GuardHarness();
        h.throwOnEventTypes = new Set<EventName>([driver.preTerminalEvent]);
        await expect(driver.runSuccess(h)).rejects.toBeInstanceOf(Error);
        assertGuardCaught(h, driver, "event_append_failed");
      });

      // task #39 — EVENT-STORE-THROW VARIANT: a throw on the TERMINAL
      // `task.completed` event itself. With the atomic seam in production the
      // terminal event rides ONE tx with the row UPDATE (`updateTaskWithEvent`),
      // so a throw here rolls back the row too — there is no half-baked
      // terminal row. In the test harness (no writer; the fallback runs the row
      // UPDATE + a separate `appendEvent`), a throw on `task.completed` is
      // caught by the wider finalize guard, which emits `task.failed` with
      // `failureKind: crashed` (a generic throw classifies as `crashed`) and
      // the row is left as the guard's `markTaskFailedIfRunning` finds it (no
      // longer `running` since the success path already moved it to `done` —
      // the guarded UPDATE is a no-op, the loud `task.failed` lands). This
      // pins the test-fallback semantics so a regression on the fallback path
      // surfaces loud.
      //
      // The planner stage is the ONE exception — the planner row's TERMINAL
      // close happens externally in `subtaskLoop.ts` (not inside
      // `runPlannerStage`), so the stage never emits `task.completed`/
      // `task.failed` for its own row; the test is a no-op there (asserted via
      // `it.skipIf(...)` rather than a conditional `if (...) it(...)` block,
      // which the no-conditional-tests lint rejects).
      it.skipIf(driver.taskKind === "plan")(
        "a throw on the terminal 'task.completed' event ⇒ the wider finalize guard catches + emits one task.failed{crashed} + re-throws",
        async () => {
          const h = new GuardHarness();
          h.throwOnEventTypes = new Set<EventName>(["task.completed"]);
          await expect(driver.runSuccess(h)).rejects.toBeInstanceOf(Error);
          // The guard's emit-on-throw lands a single `task.failed`; the row
          // UPDATE in the guarded path is a no-op (the success branch already
          // moved it to `done`), so we assert ONLY the loud event invariant.
          const failedEvents = h.events.filter((e) => e.eventType === "task.failed");
          expect(failedEvents.length).toBeGreaterThanOrEqual(1);
          const observedTaskId = driver.taskId ?? failedEvents[0]!.taskId!;
          const forTask = failedEvents.filter((e) => e.taskId === observedTaskId);
          expect(forTask).toHaveLength(1);
          expect(forTask[0]!.payload).toMatchObject({ taskKind: driver.taskKind, failureKind: "crashed" });
        },
      );
    });
  }
});
