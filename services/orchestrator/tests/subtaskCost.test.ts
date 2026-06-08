import { describe, expect, it, vi } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import type { ProviderCostCapture } from "../src/engine/costs/generationCostCapture.js";
import {
  buildSubtaskCostContext,
  recordAnswererCost,
  recordWriterCost,
  secondsSince,
  type SubtaskCostContext,
  type TokenAccountingRole,
} from "../src/engine/workflow/subtaskCost.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import {
  emptyTokenUsage,
  type AnswererAdapter,
  type TokenUsage,
  type WriterAdapter,
} from "../src/engine/providers/types.js";

// Capture loud usage.token_accounting_failed emissions for the assertions below.
interface AccountingFailure {
  role: TokenAccountingRole;
  cli: string;
  model: string;
  taskId: string;
}

// subtaskCost.ts owns the cost-record context every planner/checker/auditor/
// writer call funnels through. The mutation survivors were that the recorded
// payload values (cli, model, authRef, runtimeSeconds, the disjoint token
// breakdown) and the secondsSince clamping math were never asserted. A fake
// CostRecorder captures exactly what is persisted so a mutated field/literal
// shows up as a failing assertion.

interface RecordCall {
  context: Record<string, unknown>;
  tokens: TokenUsage;
  rawUsage: Record<string, unknown>;
}

function recordingRecorder(): { recorder: CostRecorder; calls: RecordCall[] } {
  const calls: RecordCall[] = [];
  const recorder = {
    async record(context: Record<string, unknown>, tokens: TokenUsage, rawUsage: Record<string, unknown>) {
      calls.push({ context, tokens, rawUsage });
      return undefined as never;
    },
  } as unknown as CostRecorder;
  return { recorder, calls };
}

function ctx(recorder: CostRecorder, accountingFailures?: AccountingFailure[]): SubtaskCostContext {
  return {
    recorder,
    runId: "run_1",
    specId: "spec_1",
    projectId: "proj_1",
    ...(accountingFailures !== undefined && {
      emitTokenAccountingFailed: async (input) => {
        accountingFailures.push(input);
      },
    }),
  };
}

// A module-scope capturer (identity-stable) for the threading assertion.
const sharedCapturer = async (): Promise<ProviderCostCapture> => ({ cost: 1 });

const answererAdapter: AnswererAdapter<unknown> = {
  kind: "answerer",
  cli: "codex",
  authRef: "vault://codex/key",
  async runAnswerer() {
    return {};
  },
};

const writerAdapter: WriterAdapter = {
  kind: "writer",
  cli: "claude",
  authRef: "vault://claude/key",
  async runWriter() {
    return { diff: "", commits: [], exitReason: "completed" };
  },
};

describe("recordAnswererCost", () => {
  it("records zero tokens, the answerer's cli/authRef, and the supplied model + runtime", async () => {
    const { recorder, calls } = recordingRecorder();
    await recordAnswererCost({
      ctx: ctx(recorder),
      adapter: answererAdapter,
      role: "planner",
      taskId: "task_planner",
      model: "tanren-planner",
      runtimeSeconds: 4.5,
      rawUsage: { role: "planner" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.context).toMatchObject({
      runId: "run_1",
      taskId: "task_planner",
      specId: "spec_1",
      projectId: "proj_1",
      cli: "codex",
      model: "tanren-planner",
      authRef: "vault://codex/key",
      runtimeSeconds: 4.5,
    });
    // Answerer calls have no token breakdown -> the empty (all-zero) usage.
    expect(call.tokens).toEqual(emptyTokenUsage);
    expect(call.rawUsage).toEqual({ role: "planner" });
  });

  it("LOUD: a REAL answerer call with no token telemetry emits usage.token_accounting_failed", async () => {
    const { recorder } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      adapter: answererAdapter,
      role: "auditor",
      taskId: "task_audit",
      model: "tanren-auditor",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    // A real CLI (codex) recorded zero tokens → surfaced loudly, NOT a silent $0 row.
    expect(failures).toEqual([{ role: "auditor", cli: "codex", model: "tanren-auditor", taskId: "task_audit" }]);
  });

  it("QUIET: a FAKE-fixture answerer (legitimate zero) does NOT emit token_accounting_failed", async () => {
    const { recorder } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordAnswererCost({
      ctx: ctx(recorder, failures),
      adapter: { ...answererAdapter, cli: "fake" },
      role: "checker",
      taskId: "task_check",
      model: "tanren-checker",
      runtimeSeconds: 1,
      rawUsage: {},
    });
    expect(failures).toEqual([]);
  });
});

describe("recordWriterCost", () => {
  it("records the writer's reported token usage and the fixed tanren-writer model", async () => {
    const { recorder, calls } = recordingRecorder();
    const tokenUsage: TokenUsage = {
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheCreationTokens: 5,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 185,
    };
    await recordWriterCost({
      ctx: ctx(recorder),
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 12,
      tokenUsage,
      rawUsage: { role: "writer" },
    });

    const call = calls[0]!;
    expect(call.context).toMatchObject({
      taskId: "task_write",
      cli: "claude",
      model: "tanren-writer",
      authRef: "vault://claude/key",
      runtimeSeconds: 12,
    });
    expect(call.tokens).toBe(tokenUsage);
  });

  it("falls back to the empty token usage AND emits a LOUD token_accounting_failed when the writer reports none", async () => {
    const { recorder, calls } = recordingRecorder();
    const failures: AccountingFailure[] = [];
    await recordWriterCost({
      ctx: ctx(recorder, failures),
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: undefined,
      rawUsage: {},
    });
    expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
    // A REAL writer call missing telemetry is surfaced loudly, NOT a silent zero-token row.
    expect(failures).toEqual([{ role: "writer", cli: "claude", model: "tanren-writer", taskId: "task_write" }]);
  });

  it("captures the REAL provider cost for a managed call carrying an OpenRouter generation id", async () => {
    // A managed run surfaced an openRouterGenerationId on the writer's token usage and
    // wired a capturer → the recorder context carries the captured real FACT, so
    // cost_usd becomes a metered figure (provider_response) downstream.
    const { recorder, calls } = recordingRecorder();
    const captured: string[] = [];
    const capturer = async (generationId: string): Promise<ProviderCostCapture> => {
      captured.push(generationId);
      return { cost: 0.0321 };
    };
    await recordWriterCost({
      ctx: { ...ctx(recorder), captureRealProviderCost: capturer },
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-abc123" },
      rawUsage: {},
    });
    expect(captured).toEqual(["gen-abc123"]);
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: 0.0321 });
  });

  it("LOUD: a managed capture FAILURE emits cost.provider_capture_failed and records null cost", async () => {
    const { recorder, calls } = recordingRecorder();
    const captureFailures: { generationId: string; detail: string; taskId: string }[] = [];
    await recordWriterCost({
      ctx: {
        ...ctx(recorder),
        captureRealProviderCost: async (generationId): Promise<ProviderCostCapture> => ({
          failed: { generationId, detail: "boom 500" },
        }),
        emitProviderCaptureFailed: async (input) => {
          captureFailures.push(input);
        },
      },
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-fail" },
      rawUsage: {},
    });
    // Authoritative platform spend could not be captured → surfaced loudly, cost null.
    expect(captureFailures).toEqual([{ generationId: "gen-fail", detail: "boom 500", taskId: "task_write" }]);
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });

  it("does NOT capture (real cost null) when no generation id is present, even with a capturer wired", async () => {
    const { recorder, calls } = recordingRecorder();
    const capturer = vi.fn<(generationId: string) => Promise<ProviderCostCapture>>(async () => ({ cost: 0.5 }));
    await recordWriterCost({
      ctx: { ...ctx(recorder), captureRealProviderCost: capturer },
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1 },
      rawUsage: {},
    });
    expect(capturer).not.toHaveBeenCalled();
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });

  it("does NOT capture when a generation id is present but NO capturer is wired (BYOK / non-managed)", async () => {
    const { recorder, calls } = recordingRecorder();
    await recordWriterCost({
      ctx: ctx(recorder),
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: { ...emptyTokenUsage, inputTokens: 1, totalTokens: 1, openRouterGenerationId: "gen-xyz" },
      rawUsage: {},
    });
    expect(calls[0]!.context).toMatchObject({ realProviderCostUsd: null });
  });
});

describe("buildSubtaskCostContext", () => {
  it("wires both loud event sinks over the loop's appendEvent (token_accounting_failed + provider_capture_failed)", async () => {
    const { recorder } = recordingRecorder();
    const appended: Array<{ type: string; payload: Record<string, unknown>; taskId?: string }> = [];
    const appendEvent = (async (type, payload, taskId) => {
      appended.push({ type, payload: payload as Record<string, unknown>, taskId });
    }) as AppendEvent;
    const built = buildSubtaskCostContext(
      { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" },
      appendEvent,
    );
    await built.emitTokenAccountingFailed?.({ role: "writer", cli: "claude", model: "tanren-writer", taskId: "t1" });
    await built.emitProviderCaptureFailed?.({ generationId: "gen-1", detail: "boom", taskId: "t2" });
    expect(appended.map((a) => a.type)).toEqual(["usage.token_accounting_failed", "cost.provider_capture_failed"]);
    expect(appended[0]).toMatchObject({ payload: { role: "writer", cli: "claude" }, taskId: "t1" });
    expect(appended[1]).toMatchObject({ payload: { generationId: "gen-1", detail: "boom" }, taskId: "t2" });
  });

  it("threads the managed capturer through when supplied", () => {
    const { recorder } = recordingRecorder();
    const appendEvent = (async () => {}) as AppendEvent;
    const built = buildSubtaskCostContext(
      { recorder, runId: "r", specId: "s", projectId: "p", captureRealProviderCost: sharedCapturer },
      appendEvent,
    );
    expect(built.captureRealProviderCost).toBe(sharedCapturer);
  });
});

describe("secondsSince", () => {
  it("returns the elapsed seconds for a past start time", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // 3000ms earlier -> exactly 3 seconds.
      expect(secondsSince(now - 3000)).toBeCloseTo(3, 5);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("clamps a non-positive elapsed to the 0.001 floor (never zero/negative)", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Same instant -> elapsed 0, which must be floored, not returned as 0.
      expect(secondsSince(now)).toBe(0.001);
      // Future start -> negative elapsed, also floored.
      expect(secondsSince(now + 5000)).toBe(0.001);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
