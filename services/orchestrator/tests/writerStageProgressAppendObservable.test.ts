// Codex critic finding #1 — the writerStage `onWatchdogProgress` callback fires
// `writer.subtask.progress` fire-and-forget so a rejected appendEvent cannot
// bubble into the SSH watchdog tick. The prior empty `.catch(() => {})` also
// swallowed the failure SILENTLY — a broken control-plane event writer then
// invisibly severs the cross-layer sign-of-life bridge (the #21B child-run
// progress breaker reads the writer as no-longer-signaling while the actual
// work signature is still advancing), and an operator investigating "why did
// the watchdog fire on a spec that was making progress" has zero durable
// evidence of the transport failure. The fix routes the catch through the
// structured logger (`writer-watchdog-progress`) so exactly one JSON line lands
// on stderr per failed append, keyed by `runId` / `taskId` / `subtaskIndex`.
//
// This suite pins the observability + contract-preservation properties:
//   1. On appendEvent throw, a structured log line is emitted carrying the
//      run/task/subtask lineage and the error message.
//   2. The callback still does NOT throw upstream (the watchdog contract).
//   3. Clean-path behavior is unchanged (no spurious log on success).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import type { WatchdogProgressSignal } from "../src/engine/contracts/commandSubstrate.js";
import type { WriterAdapter, WriterResult } from "../src/engine/providers/types.js";
import { runWriterStage } from "../src/engine/workflow/subtaskStages.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { fakeAuthRef } from "./helpers/plannerLoopHelpers.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

// A writer that, before returning a clean completion, synchronously invokes the
// substrate's `onWatchdogProgress` callback with a canned advance signal. The
// signal shape mirrors what `buildActivityWatchdog` forwards from the SSH
// substrate — an `outputBytesAdvanced` count and an optional workspace
// signature — so the closure the writerStage builds exercises the SAME code
// path a production tick would exercise.
function makeProgressSignallingWriter(signal: WatchdogProgressSignal): WriterAdapter {
  return {
    kind: "writer",
    cli: "fake",
    authRef: fakeAuthRef,
    async runWriter(opts): Promise<WriterResult> {
      opts.onWatchdogProgress?.(signal);
      return {
        diff: "diff --git README\n+ok\n",
        commits: [{ sha: "sha_1", message: "subtask 1" }],
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

// A tiny harness with a scriptable `appendEvent` — the test wires it to REJECT
// only for `writer.subtask.progress` so every OTHER event the stage emits
// (task.started, writer.subtask.started, writer.subtask.completed, task.completed)
// still lands cleanly. That lets the assertions read a normal completed outcome
// AND still observe the log emitted for the broken progress-append path.
class Harness {
  readonly events: Array<{ eventType: EventName; payload: Record<string, unknown> }> = [];
  readonly writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      this.events.push({
        eventType: input.eventType as EventName,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });
  progressAppendError: Error | null = null;

  appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>): Promise<void> => {
    if (eventType === "writer.subtask.progress" && this.progressAppendError !== null) {
      throw this.progressAppendError;
    }
    this.events.push({ eventType, payload: payload as Record<string, unknown> });
  };

  query = async (_sql: string, _params: ReadonlyArray<unknown> = []): Promise<{ rows: never[]; rowCount: number }> => {
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
  index: 7,
  title: "wire the bridge",
  intent: "keep the breaker alive on the slow tick",
  behaviorIds: ["B1"],
  estimatedTokens: null,
};

function callArgs(h: Harness, adapter: WriterAdapter) {
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
    appendEvent: h.appendEvent,
  };
}

// Flush the microtask + macro-task queues so the fire-and-forget `void`
// promise chain in `onWatchdogProgress` settles: the appendEvent throw
// schedules the `.catch` handler which runs on a subsequent microtask.
const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
async function flush(): Promise<void> {
  await tick();
  await tick();
}

describe("runWriterStage — onWatchdogProgress append observability (Codex critic #1)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The structured logger prints warn/error via console.error. Silence it so
    // the test output stays clean, but capture calls so we can assert on the
    // emitted JSON line.
    logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a structured log carrying runId/taskId/subtaskIndex when the progress-append rejects", async () => {
    const h = new Harness();
    h.progressAppendError = new Error("event-store transport down");
    const writer = makeProgressSignallingWriter({
      outputBytesAdvanced: 4096,
      workspaceSignature: "ws:2100:9876543",
      workSignatureAdvanced: true,
    });

    const outcome = await runWriterStage(callArgs(h, writer));
    // Let the fire-and-forget `void appendEvent(...).catch(...)` settle.
    await flush();

    // Contract preservation: the callback failure must not bubble — the writer
    // still completed cleanly, and the terminal pair still emitted.
    expect(outcome.kind).toBe("completed");
    expect(h.names()).toContain("writer.subtask.completed");
    expect(h.names()).toContain("task.completed");

    // Observability: exactly one warn line lands, carrying the run/task/subtask
    // lineage the operator needs to correlate + the underlying error message.
    const emitted = logSpy.mock.calls.map((call) => String(call[0]));
    const match = emitted.find(
      (line) =>
        line.includes("writer.subtask.progress append failed") &&
        line.includes('"runId":"run_1"') &&
        line.includes('"taskId":"task_write"') &&
        line.includes('"subtaskIndex":7') &&
        line.includes("event-store transport down"),
    );
    expect(match).toBeDefined();
  });

  it("does not throw upstream when the progress-append rejects (watchdog contract)", async () => {
    const h = new Harness();
    h.progressAppendError = new Error("boom");
    const writer = makeProgressSignallingWriter({
      outputBytesAdvanced: 128,
      workSignatureAdvanced: true,
    });

    // If the fix regressed the `.catch`, `runWriterStage` would reject because
    // the writer's synchronous `opts.onWatchdogProgress?.(...)` call would let
    // an unhandled promise rejection escape into the closure return. The
    // assertion here is that the whole call resolves — a NON-throw is the
    // contract the SSH substrate depends on.
    await expect(runWriterStage(callArgs(h, writer))).resolves.toMatchObject({ kind: "completed" });
    await flush();
  });

  it("does NOT log when the progress-append succeeds (clean path unchanged)", async () => {
    const h = new Harness();
    // Leave progressAppendError = null → the append lands normally.
    const writer = makeProgressSignallingWriter({
      outputBytesAdvanced: 2048,
      workspaceSignature: "ws:100:20000",
      workSignatureAdvanced: true,
    });

    const outcome = await runWriterStage(callArgs(h, writer));
    await flush();

    expect(outcome.kind).toBe("completed");
    // The progress event itself landed on the normal event stream.
    expect(h.names()).toContain("writer.subtask.progress");
    // No progress-append warn line was emitted (silent success).
    const emitted = logSpy.mock.calls.map((call) => String(call[0]));
    const noise = emitted.find((line) => line.includes("writer.subtask.progress append failed"));
    expect(noise).toBeUndefined();
  });
});
