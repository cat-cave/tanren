// C2 (RUN-HALT-CORRECTNESS): runWriterStage must READ the provider's classified
// `exitReason` and never launder a non-`completed` writer into a passed task.
// A crashed / timed-out writer is a hard FAILED task (routed to rework); a
// window-exhausted writer is the recoverable §4.3 window-pressure terminal.
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import { runWriterStage, type WriterStageOutcome } from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { makeFailingWriter, makeWriter } from "./helpers/plannerLoopHelpers.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
}

// A tiny pg-shaped harness that captures the task-row UPDATE the stage issues so
// we can assert it lands `done`/`passed` vs `failed`/<kind> WITHOUT a database.
class Harness {
  readonly events: RecordedEvent[] = [];
  status: string | null = null;
  outcomeOrKind: string | null = null;

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    const trimmed = sql.trim();
    // params[1] is failure_kind on the failed UPDATE, outcome on the done UPDATE.
    if (trimmed.startsWith("UPDATE tasks SET status = 'failed'")) {
      this.status = "failed";
      this.outcomeOrKind = String(params[1]);
    } else if (trimmed.startsWith("UPDATE tasks SET status")) {
      this.status = "done";
      this.outcomeOrKind = String(params[1]);
    }
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = { record: async () => undefined as never } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
  }

  names(): EventName[] {
    return this.events.map((event) => event.eventType);
  }
}

const subtask: PlanSubtask = {
  index: 0,
  title: "Wire behavior B1",
  intent: "touch the README",
  behaviorIds: ["B1"],
  estimatedTokens: null,
};

function callArgs(h: Harness, adapter: ReturnType<typeof makeWriter>) {
  return {
    pool: { query: h.query },
    costCtx: h.costCtx(),
    adapter,
    runId: "run_1",
    workspacePath: "/ws",
    plannerTaskId: "task_plan",
    subtask,
    writeTaskId: "task_write",
    prompt: "write it",
    timeoutMs: 1000,
    appendEvent: h.appendEvent,
  };
}

describe("runWriterStage — exitReason routing (C2)", () => {
  it("a completed writer is marked passed and emits writer.subtask.completed + task.completed", async () => {
    const h = new Harness();
    const outcome = await runWriterStage(callArgs(h, makeWriter(["diff body\n"])));

    expect(outcome.kind).toBe("completed");
    expect(h.status).toBe("done");
    expect(h.outcomeOrKind).toBe("passed");
    expect(h.names()).toContain("writer.subtask.completed");
    expect(h.names()).toContain("task.completed");
    expect(h.names()).not.toContain("writer.subtask.failed");
    expect(h.names()).not.toContain("task.failed");
  });

  it("a crashed writer is a FAILED task (kind=failed/crashed), never passed/completed", async () => {
    const h = new Harness();
    const outcome = await runWriterStage(callArgs(h, makeFailingWriter("crashed")));

    expect(outcome.kind).toBe("failed");
    expect(failureKindOf(outcome)).toBe("crashed");
    expect(h.status).toBe("failed");
    expect(h.outcomeOrKind).toBe("crashed");
    expect(h.names()).toContain("writer.subtask.failed");
    expect(h.names()).toContain("task.failed");
    // The success events are NEVER emitted for a crashed run.
    expect(h.names()).not.toContain("writer.subtask.completed");
    expect(h.names()).not.toContain("task.completed");
  });

  it("a timed-out writer is a FAILED task (kind=failed/timeout), never passed/completed", async () => {
    const h = new Harness();
    const outcome = await runWriterStage(callArgs(h, makeFailingWriter("timeout")));

    expect(outcome.kind).toBe("failed");
    expect(failureKindOf(outcome)).toBe("timeout");
    expect(h.status).toBe("failed");
    expect(h.outcomeOrKind).toBe("timeout");
    expect(h.names()).not.toContain("task.completed");
  });

  it("a window-exhausted writer routes to kind=window_exhausted and fails the task (never passed)", async () => {
    const h = new Harness();
    const outcome = await runWriterStage(callArgs(h, makeFailingWriter("window_exhausted")));

    expect(outcome.kind).toBe("window_exhausted");
    expect(h.status).toBe("failed");
    expect(h.outcomeOrKind).toBe("window_exhausted");
    expect(h.names()).toContain("writer.subtask.failed");
    expect(h.names()).toContain("task.failed");
    expect(h.names()).not.toContain("task.completed");
  });

  it("a token_limit writer is a clean stop: marked passed (existing semantics)", async () => {
    const h = new Harness();
    const outcome = await runWriterStage(callArgs(h, makeFailingWriter("token_limit")));

    expect(outcome.kind).toBe("completed");
    expect(h.status).toBe("done");
    expect(h.outcomeOrKind).toBe("passed");
    expect(h.names()).toContain("task.completed");
  });
});

// Narrow without a conditional expect (the lint forbids `if (...) expect(...)`).
function failureKindOf(outcome: WriterStageOutcome): string | undefined {
  return outcome.kind === "failed" ? outcome.failureKind : undefined;
}
