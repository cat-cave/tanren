// PR — terminal-atomicity + watchdog + breaker + cadence cleanups.
//
// Tests #21 + #46: the planner task's terminal pair (the planner-level
// `task.failed` after a window-exhausted preflight / a convergence-halt, and
// `task.completed` on a clean pass) must route through the writer seam's
// `updateTaskWithEvent` so the row UPDATE + the terminal event commit in ONE
// org-scoped transaction (`RunStateWriter.updateTaskWithEvent`), matching the
// writer / checker / auditor stages.
//
// Pre-PR shape (the residue task #46 fixes): `markTaskDone(...)` + a separate
// `appendEvent("task.completed"/"task.failed", ...)` — a SPLIT that could strand
// the row terminal-`done` with no event on a crash between the two writes
// (autonomy-engine.md §1c single-finalize invariant).
//
// Pre-PR shape (the residue task #21 fixes): `runPlannerStage`'s finalize guard
// fell through to the no-writer split path on the failure leg, because
// `PlannerStageInput` did not carry the writer; the planner-throw rendered a
// `task.failed` event via `appendEvent` but the row UPDATE went directly through
// the pool (split from the event).

import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { runPlannerStage } from "../src/engine/workflow/subtaskStages.js";
import { CodexUsageLimitError } from "../src/engine/providers/codex.js";
import type { PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import type {
  AppendSpecSteeringInput,
  ClearRunPercolationPendingInput,
  CreateQueuedRunInput,
  CreateSpecRemoteInput,
  FinalizeLandInput,
  FinalizeRunInput,
  FinalizeRunResult,
  FinalizeRunWithEventInput,
  FinalizeRunWithEventOutcome,
  InsertTaskInput,
  MergeRunVerifiedAncestorShaInput,
  RecordCostInput,
  ReconcileCostInput,
  ResumePausedRunAtomicInput,
  ResumePausedRunAtomicOutcome,
  RunStateWriter,
  SetRunAuthRefInput,
  SetRunPercolationReexecIdInput,
  SetRunPrUrlInput,
  SetRunSpeculativeBaseInput,
  SetRunStatusInput,
  SetSpecMetadataInput,
  SetSpecStatusInput,
  UpdateSpecWithEventInput,
  UpdateSpecWithEventOutcome,
  UpdateTaskInput,
  UpdateTaskWithEventInput,
  UpdateTaskWithEventOutcome,
} from "../src/engine/contracts/runStateWriter.js";
import type { RecordedCost } from "../src/engine/costs/recorder.js";
import type { SpecContract, SpecRunContract } from "../src/engine/workflow/projectSpec.js";
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceStalled,
  defaultLoopInput,
  fakeAuthRef,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makePlanner,
  makeTriage,
  makeWriter,
  triageMildTasks,
} from "./helpers/plannerLoopHelpers.js";

// A minimal RunStateWriter recorder that captures every atomic terminal-pair call
// + every other write. Production wires `DirectRunStateWriter` (in-process) or
// `HttpRunStateWriter` (control-plane); the contract these tests pin is that the
// terminal pair flows through `updateTaskWithEvent` regardless of which impl is
// behind the seam.
class RecordingWriter implements RunStateWriter {
  readonly terminalPairs: UpdateTaskWithEventInput[] = [];
  readonly insertedTasks: InsertTaskInput[] = [];

  // EventStore surface — never used by these tests, but the seam requires it.
  // eslint-disable-next-line @typescript-eslint/require-await
  async append(): Promise<void> {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async recordCost(_input: RecordCostInput): Promise<RecordedCost> {
    return { id: "cost_x", costUsd: "0", totalTokens: 0 } as unknown as RecordedCost;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async reconcileCost(_input: ReconcileCostInput): Promise<{ updated: number }> {
    return { updated: 0 };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeRun(_input: FinalizeRunInput): Promise<FinalizeRunResult> {
    return { updated: false };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async setRunStatus(_input: SetRunStatusInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setRunPrUrl(_input: SetRunPrUrlInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setRunAuthRef(_input: SetRunAuthRefInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setSpecStatus(_input: SetSpecStatusInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setSpecMetadata(_input: SetSpecMetadataInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async appendSpecSteering(_input: AppendSpecSteeringInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setRunSpeculativeBase(_input: SetRunSpeculativeBaseInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async setRunPercolationReexecId(_input: SetRunPercolationReexecIdInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async clearRunPercolationPending(_input: ClearRunPercolationPendingInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async mergeRunVerifiedAncestorSha(_input: MergeRunVerifiedAncestorShaInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async supersedeQueuedPlannerTask(_input: { runId: string; orgId?: string }): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeLand(_input: FinalizeLandInput): Promise<{ auditId: string }> {
    return { auditId: "audit_x" };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async insertTask(input: InsertTaskInput): Promise<void> {
    this.insertedTasks.push(input);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateTask(_input: UpdateTaskInput): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateTaskWithEvent(input: UpdateTaskWithEventInput): Promise<UpdateTaskWithEventOutcome> {
    this.terminalPairs.push(input);
    return { alreadyTerminal: false };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async finalizeRunWithEvent(_input: FinalizeRunWithEventInput): Promise<FinalizeRunWithEventOutcome> {
    return { updated: false, alreadyTerminal: false };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async updateSpecWithEvent(_input: UpdateSpecWithEventInput): Promise<UpdateSpecWithEventOutcome> {
    return { flipped: false, alreadyTerminal: false };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async resumePausedRunAtomic(_input: ResumePausedRunAtomicInput): Promise<ResumePausedRunAtomicOutcome> {
    return { runFinalized: false, runEventAlreadyTerminal: false, specFlipped: false };
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async createQueuedRun(_input: CreateQueuedRunInput): Promise<SpecRunContract> {
    return {} as SpecRunContract;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async createSpec(_input: CreateSpecRemoteInput): Promise<SpecContract> {
    return {} as SpecContract;
  }
}

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

describe("plannerStage failure path threads the writer (task #21)", () => {
  it("a planner-throw routes the FAILED terminal pair through writer.updateTaskWithEvent when the writer is wired", async () => {
    const writer = new RecordingWriter();
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    const costCtx: SubtaskCostContext = {
      recorder,
      runId: "run_1",
      specId: "spec_1",
      projectId: "proj_1",
    };
    const planner = throwingAnswerer<PlanAnswer>(
      new CodexUsageLimitError("PlanAnswer", "5-hour window exhausted mid-call"),
    );

    // The planner THROWS; the finalize guard catches + commits the atomic FAILED
    // terminal pair through the writer seam, then re-throws so the workflow's
    // outer catch in plannerRun runs the run-level disposition.
    await expect(
      runPlannerStage({
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
        writer,
        costCtx,
        adapter: planner,
        spec: {
          specTitle: "S",
          specDescription: "D",
          acceptanceCriteria: ["AC1"],
          behaviorIds: [],
          behaviorContext: [],
        },
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan_throw",
        appendEvent: async () => {
          /* no-op recorder for this test */
        },
        attempt: 1,
        rejectionHistory: [],
      }),
    ).rejects.toBeInstanceOf(CodexUsageLimitError);

    // The FAILED terminal pair landed through the writer seam — ONE atomic
    // org-scoped transaction (not the no-writer split fallback).
    expect(writer.terminalPairs).toHaveLength(1);
    const pair = writer.terminalPairs[0]!;
    expect(pair.task).toMatchObject({
      taskId: "task_plan_throw",
      transition: "failed_with_kind_if_running",
      failureKind: "window_exhausted",
    });
    expect(pair.event).toMatchObject({
      runId: "run_1",
      specId: "spec_1",
      projectId: "proj_1",
      taskId: "task_plan_throw",
      eventType: "task.failed",
    });
    expect(pair.event.payload).toMatchObject({
      taskKind: "plan",
      failureKind: "window_exhausted",
    });
  });
});

describe("runSubtaskLoop planner-task terminal pairs route through the writer seam (task #46)", () => {
  it("clean pass routes through writer.updateTaskWithEvent (task.completed)", async () => {
    const writer = new RecordingWriter();
    const { input } = defaultLoopInput({
      runStateWriter: writer,
      adapters: {
        ...defaultLoopInput().input.adapters,
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    // The planner task's terminal pair (task.completed) flowed through the seam.
    const plannerDone = writer.terminalPairs.find(
      (pair) => (pair.event.payload as { taskKind?: string }).taskKind === "plan",
    );
    expect(plannerDone).toBeDefined();
    expect(plannerDone!.task).toMatchObject({ transition: "done", outcome: "passed" });
    expect(plannerDone!.event.eventType).toBe("task.completed");
  });

  it("convergence-stalled halt routes through writer.updateTaskWithEvent (task.failed/convergence_stalled)", async () => {
    const writer = new RecordingWriter();
    // Auditor surfaces a finding (so triage runs); triage keeps it in-spec (mild
    // task); convergence STALLs with the escalate verdict → planner-level halt.
    const { input } = defaultLoopInput({
      runStateWriter: writer,
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([buildPlan([{ title: "T1", intent: "i", behaviorIds: ["B1"] }])]),
        writer: makeWriter(["diff body\n"]),
        checker: makeChecker([completeCheck]),
        auditor: makeAuditor([{ findings: [{ id: "f1", severity: "P0", title: "blocking", body: "still blocking" }] }]),
        triage: makeTriage([triageMildTasks]),
        convergence: makeConvergence([convergenceStalled]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("convergence_stalled");
    const plannerFailed = writer.terminalPairs.find(
      (pair) => (pair.event.payload as { taskKind?: string }).taskKind === "plan",
    );
    expect(plannerFailed).toBeDefined();
    expect(plannerFailed!.task).toMatchObject({
      transition: "failed_with_kind",
      failureKind: "convergence_stalled",
    });
    expect(plannerFailed!.event.eventType).toBe("task.failed");
    expect(plannerFailed!.event.payload).toMatchObject({
      taskKind: "plan",
      failureKind: "convergence_stalled",
    });
  });
});
