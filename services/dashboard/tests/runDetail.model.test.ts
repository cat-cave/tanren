// P2B-0004 — unit tests for the pure run-detail view-model derivations
// (cost summary, trajectory spine, reasoning extraction). No DOM, no rendering.

import { describe, expect, it } from "vitest";
import {
  buildTrajectory,
  failedTasks,
  formatDuration,
  reasoningForTask,
  runFailed,
  spineProgress,
  summarizeCosts,
  taskState
} from "../src/components/runDetail/model.js";
import type { RunCostRecord, RunDetail, TaskTimelineEntry } from "../src/api/types.js";

function task(over: Partial<TaskTimelineEntry>): TaskTimelineEntry {
  return {
    taskId: "t1",
    runId: "run_1",
    kind: "write",
    parentTaskId: null,
    title: "do a thing",
    status: "done",
    outcome: "passed",
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-x",
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: "2026-05-28T10:01:00.000Z",
    ...over
  };
}

function cost(over: Partial<RunCostRecord>): RunCostRecord {
  return {
    id: 1,
    runId: "run_1",
    taskId: "t1",
    projectId: "p1",
    cli: "codex",
    provider: "openai",
    model: "gpt-x",
    inputTokens: 100,
    cachedInputTokens: 10,
    cacheCreationTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    totalTokens: 150,
    costUsd: "0.0200",
    billingMode: "per_token",
    costBasis: "provider_pricing",
    recordedAt: "2026-05-28T10:00:30.000Z",
    ...over
  };
}

describe("summarizeCosts — cost bar across all sources", () => {
  it("aggregates real dollars, tokens, and per-source/per-model totals", () => {
    const totals = summarizeCosts([
      cost({ id: 1, billingMode: "per_token", costUsd: "0.0200", totalTokens: 150, model: "gpt-x" }),
      cost({ id: 2, billingMode: "subscription", costUsd: null, totalTokens: 300, model: "claude-y", provider: "anthropic" }),
      cost({ id: 3, billingMode: "self_hosted", costUsd: "0.0000", totalTokens: 80, model: "local-z" })
    ]);
    expect(totals.perTokenUsd).toBeCloseTo(0.02, 5);
    expect(totals.totalTokens).toBe(530);
    expect(totals.bySource.get("per_token")?.tokens).toBe(150);
    expect(totals.bySource.get("subscription")?.tokens).toBe(300);
    expect(totals.bySource.get("self_hosted")?.tokens).toBe(80);
    expect(totals.byModel.get("claude-y")?.provider).toBe("anthropic");
    // never invents an unknown source: only the three real billing modes appear
    expect([...totals.bySource.keys()].sort()).toEqual(["per_token", "self_hosted", "subscription"]);
  });

  it("treats a null/non-numeric costUsd as zero dollars without dropping tokens", () => {
    const totals = summarizeCosts([cost({ costUsd: null, totalTokens: 42 })]);
    expect(totals.perTokenUsd).toBe(0);
    expect(totals.totalTokens).toBe(42);
  });
});

describe("trajectory spine", () => {
  it("orders moments by start, numbers write subtasks, and maps states", () => {
    const moments = buildTrajectory([
      task({ taskId: "plan", kind: "plan", title: "plan", startedAt: "2026-05-28T10:00:00.000Z" }),
      task({ taskId: "w1", kind: "write", startedAt: "2026-05-28T10:01:00.000Z", status: "done" }),
      task({ taskId: "w2", kind: "write", startedAt: "2026-05-28T10:02:00.000Z", status: "running", outcome: null, endedAt: null }),
      task({ taskId: "audit", kind: "audit", status: "queued", outcome: null, startedAt: null, endedAt: null })
    ]);
    expect(moments.map((m) => m.taskId)).toEqual(["plan", "w1", "w2", "audit"]);
    expect(moments[1].phase).toBe("write subtask 1");
    expect(moments[2].phase).toBe("write subtask 2");
    expect(moments[2].state).toBe("live");
    expect(moments[3].state).toBe("queued");
  });

  it("maps rejected outcomes to a failed state (the rejection loop)", () => {
    expect(taskState(task({ status: "done", outcome: "rejected_by_auditor" }))).toBe("failed");
    expect(taskState(task({ status: "done", outcome: "rejected_by_checker" }))).toBe("failed");
  });

  it("derives a gradient where done < live", () => {
    const moments = buildTrajectory([
      task({ taskId: "a", status: "done", startedAt: "2026-05-28T10:00:00.000Z" }),
      task({ taskId: "b", status: "running", outcome: null, endedAt: null, startedAt: "2026-05-28T10:01:00.000Z" }),
      task({ taskId: "c", status: "queued", outcome: null, startedAt: null, endedAt: null })
    ]);
    const { donePct, livePct } = spineProgress(moments);
    expect(donePct).toBeLessThan(livePct);
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes, empty when unstarted", () => {
    expect(formatDuration("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:45.000Z")).toBe("45s");
    expect(formatDuration("2026-05-28T10:00:00.000Z", "2026-05-28T10:02:05.000Z")).toBe("2m 5s");
    expect(formatDuration(null, null)).toBe("");
  });
});

describe("reasoningForTask — structured fields from typed events (not stdout)", () => {
  it("extracts intent, tool calls, and decisions from the event payloads", () => {
    const detail = {
      tasks: [task({ taskId: "w2" })],
      recentEvents: [
        { id: 1, ts: "", runId: "run_1", taskId: "w2", specId: null, projectId: null, eventType: "writer.intent", payload: { intent: "wire localStorage persistence" }, redactedPaths: [] },
        { id: 2, ts: "", runId: "run_1", taskId: "w2", specId: null, projectId: null, eventType: "tool.call", payload: { tool: "edit_file", arg: "settings.tsx", output: "+12 -3" }, redactedPaths: [] },
        { id: 3, ts: "", runId: "run_1", taskId: "w2", specId: null, projectId: null, eventType: "writer.decision", payload: { decisions: ["use useEffect", "defer profile sync"] }, redactedPaths: [] },
        { id: 4, ts: "", runId: "run_1", taskId: "other", specId: null, projectId: null, eventType: "noise", payload: { intent: "ignore me" }, redactedPaths: [] }
      ]
    } as unknown as RunDetail;
    const reasoning = reasoningForTask(detail, "w2");
    expect(reasoning.intent).toBe("wire localStorage persistence");
    expect(reasoning.tools).toHaveLength(1);
    expect(reasoning.tools[0].name).toBe("edit_file");
    expect(reasoning.decisions).toEqual(["use useEffect", "defer profile sync"]);
    // only this moment's events are surfaced
    expect(reasoning.events.every((e) => e.taskId === "w2")).toBe(true);
  });
});

describe("failure detection (rejection loop inspection)", () => {
  it("flags failed/halted runs and lists the rejected tasks", () => {
    const detail = {
      run: { status: "halted", outcome: "halted" },
      tasks: [
        task({ taskId: "ok", status: "done", outcome: "passed" }),
        task({ taskId: "bad", status: "done", outcome: "rejected_by_auditor", failureKind: "auditor_disagreement" })
      ]
    } as unknown as RunDetail;
    expect(runFailed(detail)).toBe(true);
    expect(failedTasks(detail).map((t) => t.taskId)).toEqual(["bad"]);
  });
});
