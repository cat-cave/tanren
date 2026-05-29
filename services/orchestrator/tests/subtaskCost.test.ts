import { describe, expect, it, vi } from "vitest";
import type { CostRecorder } from "../src/engine/costs/index.js";
import {
  recordAnswererCost,
  recordWriterCost,
  secondsSince,
  type SubtaskCostContext,
} from "../src/engine/workflow/subtaskCost.js";
import {
  emptyTokenUsage,
  type AnswererAdapter,
  type TokenUsage,
  type WriterAdapter,
} from "../src/engine/providers/types.js";

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

function ctx(recorder: CostRecorder): SubtaskCostContext {
  return { recorder, runId: "run_1", specId: "spec_1", projectId: "proj_1" };
}

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

  it("falls back to the empty token usage when the writer reports none", async () => {
    const { recorder, calls } = recordingRecorder();
    await recordWriterCost({
      ctx: ctx(recorder),
      adapter: writerAdapter,
      taskId: "task_write",
      runtimeSeconds: 1,
      tokenUsage: undefined,
      rawUsage: {},
    });
    expect(calls[0]!.tokens).toEqual(emptyTokenUsage);
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
