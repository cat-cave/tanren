// C2 (RUN-HALT-CORRECTNESS): runWriterStage must READ the provider's classified
// `exitReason` and never launder a non-`completed` writer into a passed task.
// A crashed / timed-out writer is a hard FAILED task (routed to rework); a
// window-exhausted writer is the recoverable §4.3 window-pressure terminal.
import { describe, expect, it } from "vitest";
import { EventRegistry, type EventName, type EventPayload } from "../src/engine/events/index.js";
import type { TokenUsage } from "../src/engine/providers/types.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import { parseClaudeStreamTelemetry } from "../src/engine/providers/claude.js";
import { runWriterStage, type WriterStageOutcome } from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { makeFailingWriter, makeWriter } from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

interface RecordedEvent {
  eventType: EventName;
  payload: Record<string, unknown>;
}

// A tiny pg-shaped harness that captures the task-row UPDATE the stage issues so
// we can assert it lands `done`/`passed` vs `failed`/<kind> WITHOUT a database.
//
// Audit finding H3 sweep: terminal row + event pair now flows through the
// required `RunStateWriter`. The fixture's terminal `updateTaskWithEvent`
// drives both the row state (read off `writer.tasks`) AND the terminal event
// (forwarded into `events`), so the existing assertions on `h.status` /
// `h.outcomeOrKind` / `h.names()` keep holding without churn.
class Harness {
  readonly events: RecordedEvent[] = [];
  readonly costs: TokenUsage[] = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });
  get status(): string | null {
    const row = this.writer.tasks.get("task_write");
    return row?.status ?? null;
  }
  get outcomeOrKind(): string | null {
    const row = this.writer.tasks.get("task_write");
    if (row === undefined) return null;
    return row.failureKind ?? row.outcome ?? null;
  }

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
    return { rows: [], rowCount: 1 };
  };

  costCtx(): SubtaskCostContext {
    const recorder = {
      record: async (_context: unknown, usage: TokenUsage) => this.costs.push(usage),
    } as unknown as CostRecorder;
    return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1", orgId: "org_1" };
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
    writer: h.writer,
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

  it("malformed physical JSONL is typed on both failure surfaces after one exact cost", async () => {
    const h = new Harness();
    const adapter = makeFailingWriter("crashed");
    const secret = "SECRET_WRITER_STDOUT";
    const telemetry = parseClaudeStreamTelemetry(
      [
        '{"usage":{"input_tokens":2,"output_tokens":1}}',
        `not-json-${secret}`,
        '{"usage":{"input_tokens":7,"output_tokens":4}}',
      ].join("\n"),
    );
    adapter.runWriter = async () => ({
      diff: "",
      commits: [],
      exitReason: "crashed",
      tokenUsage: telemetry.tokenUsage,
      telemetry,
    });
    const outcome = await runWriterStage(callArgs(h, adapter));

    expect(outcome).toMatchObject({ kind: "failed", failureKind: "crashed" });
    expect([h.status, h.outcomeOrKind]).toEqual(["failed", "jsonl_object_decode_failed"]);
    const kind = "jsonl_object_decode_failed";
    const detail = { kind, failures: [{ lineNumber: 2, reason: "invalid_json" }] };
    const writerFailed = h.events.find((event) => event.eventType === "writer.subtask.failed");
    const taskFailed = h.events.find((event) => event.eventType === "task.failed");
    expect(writerFailed?.payload).toMatchObject({ failureKind: detail.kind, jsonlDecodeFailure: detail });
    expect(taskFailed?.payload).toMatchObject({ failureKind: detail.kind, jsonlDecodeFailure: detail });
    expect(() => EventRegistry["writer.subtask.failed"].parse(writerFailed?.payload)).not.toThrow();
    expect(() => EventRegistry["task.failed"].parse(taskFailed?.payload)).not.toThrow();
    expect(h.costs).toHaveLength(1);
    expect(h.costs[0]).toMatchObject({ inputTokens: 7, outputTokens: 4, totalTokens: 11 });
    expect(JSON.stringify([writerFailed, taskFailed])).not.toContain(secret);
    expect(h.names()).toEqual(["task.started", "writer.subtask.started", "writer.subtask.failed", "task.failed"]);
    const generic = new Harness();
    await runWriterStage(callArgs(generic, makeFailingWriter("crashed")));
    expect([generic.status, generic.outcomeOrKind]).toEqual(["failed", "crashed"]);
    expect(generic.events.find((event) => event.eventType === "task.failed")?.payload).toMatchObject({
      failureKind: "crashed",
    });
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
