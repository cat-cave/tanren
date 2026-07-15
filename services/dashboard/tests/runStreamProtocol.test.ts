import { describe, expect, it } from "vitest";
import type { TaskTimelineEntry } from "../src/api/http.gen.js";
import { RunStreamProtocol } from "../src/client/runStreamProtocol.js";

const W0 = "0".repeat(64);
const W1 = "1".repeat(64);
const W2 = "2".repeat(64);

function task(overrides: Partial<TaskTimelineEntry> = {}): TaskTimelineEntry {
  return {
    taskId: "task_plan",
    runId: "run_x",
    kind: "plan",
    parentTaskId: null,
    title: "plan the run",
    status: "running",
    outcome: null,
    failureKind: null,
    attempt: 0,
    cli: "codex",
    model: "gpt-x",
    startedAt: "2026-05-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function event(id: number | string) {
  return {
    id,
    ts: "2026-05-01T00:00:01.000Z",
    runId: "run_x",
    taskId: "task_plan",
    specId: "spec_x",
    projectId: "project_x",
    eventType: "task.updated",
    payload: {},
    redactedPaths: [],
  };
}

function cost(id: number | string) {
  return {
    id,
    runId: "run_x",
    taskId: "task_plan",
    projectId: "project_x",
    cli: "codex",
    provider: "openai",
    model: "gpt-x",
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
    costUsd: "0.001",
    billingMode: "per_token",
    costBasis: "provider_response",
    recordedAt: "2026-05-01T00:00:01.000Z",
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run_x",
    projectId: "project_x",
    run: {
      runId: "run_x",
      specId: "spec_x",
      projectId: "project_x",
      branch: "main",
      trigger: "test",
      status: "running",
      outcome: null,
      startedAt: "2026-05-01T00:00:00.000Z",
      endedAt: null,
      prUrl: null,
    },
    tasks: [],
    recentEvents: [],
    costs: [],
    eventCursor: "0",
    costCursor: "0",
    taskWatermark: W0,
    ...overrides,
  };
}

function protocol(): RunStreamProtocol {
  return new RunStreamProtocol("run_x", "project_x", "running", null);
}

describe("run SSE browser protocol", () => {
  it.each([
    ["out-of-order", [event(2), event(1)], "2"],
    ["duplicate", [event(1), event(1)], "1"],
    ["cursor ahead", [event(1)], "2"],
    ["cursor regressed", [event(1)], "0"],
  ])("rejects %s event deltas", (_name, rows, cursor) => {
    const subject = protocol();
    expect(subject.snapshot(snapshot()).ok).toBe(true);
    expect(subject.events({ runId: "run_x", projectId: "project_x", events: rows, eventCursor: cursor }).ok).toBe(
      false,
    );
  });

  it("rejects out-of-order, duplicate, ahead, and regressed cost deltas", () => {
    for (const [rows, cursor] of [
      [[cost(2), cost(1)], "2"],
      [[cost(1), cost(1)], "1"],
      [[cost(1)], "2"],
      [[cost(1)], "0"],
    ] as const) {
      const subject = protocol();
      expect(subject.snapshot(snapshot()).ok).toBe(true);
      expect(subject.costs({ runId: "run_x", projectId: "project_x", costs: rows, costCursor: cursor }).ok).toBe(false);
    }
  });

  it("accepts strict bigint deltas only when the cursor equals the final row", () => {
    const subject = protocol();
    expect(subject.snapshot(snapshot()).ok).toBe(true);
    const hugeEvent = "900719925474099312345";
    const hugeCost = "900719925474099398765";
    expect(
      subject.events({
        runId: "run_x",
        projectId: "project_x",
        events: [event(1), event(hugeEvent)],
        eventCursor: hugeEvent,
      }).ok,
    ).toBe(true);
    expect(
      subject.costs({
        runId: "run_x",
        projectId: "project_x",
        costs: [cost(1), cost(hugeCost)],
        costCursor: hugeCost,
      }).ok,
    ).toBe(true);
  });

  it("rejects snapshots and delta frames that exceed their contract caps", () => {
    const oversizedSnapshot = protocol();
    const snapshotEvents = Array.from({ length: 51 }, (_, index) => event(index + 1));
    expect(
      oversizedSnapshot.snapshot(snapshot({ recentEvents: snapshotEvents, eventCursor: "51", taskWatermark: W0 })).ok,
    ).toBe(false);

    const subject = protocol();
    expect(subject.snapshot(snapshot()).ok).toBe(true);
    const eventRows = Array.from({ length: 201 }, (_, index) => event(index + 1));
    const costRows = Array.from({ length: 201 }, (_, index) => cost(index + 1));
    expect(subject.events({ runId: "run_x", projectId: "project_x", events: eventRows, eventCursor: "201" }).ok).toBe(
      false,
    );
    expect(subject.costs({ runId: "run_x", projectId: "project_x", costs: costRows, costCursor: "201" }).ok).toBe(
      false,
    );
  });

  it("requires exact snapshot maxima and rejects cursor regression after reconnect", () => {
    const subject = protocol();
    expect(
      subject.snapshot(snapshot({ recentEvents: [event(5)], eventCursor: "6", costs: [cost(5)], costCursor: "5" })).ok,
    ).toBe(false);
    expect(
      subject.snapshot(snapshot({ recentEvents: [event(5)], eventCursor: "5", costs: [cost(5)], costCursor: "5" })).ok,
    ).toBe(true);
    expect(
      subject.snapshot(snapshot({ recentEvents: [event(8)], eventCursor: "8", costs: [cost(9)], costCursor: "9" })).ok,
    ).toBe(true);
    expect(
      subject.snapshot(snapshot({ recentEvents: [event(7)], eventCursor: "7", costs: [cost(10)], costCursor: "10" }))
        .ok,
    ).toBe(false);
    expect(
      subject.snapshot(snapshot({ recentEvents: [event(10)], eventCursor: "10", costs: [cost(8)], costCursor: "8" }))
        .ok,
    ).toBe(false);
  });

  const taskMutations: Array<[string, (value: TaskTimelineEntry) => TaskTimelineEntry]> = [
    ["taskId", (value) => ({ ...value, taskId: "task_changed" })],
    ["kind", (value) => ({ ...value, kind: "write" })],
    ["parentTaskId", (value) => ({ ...value, parentTaskId: "task_parent" })],
    ["title", (value) => ({ ...value, title: "changed title" })],
    ["status", (value) => ({ ...value, status: "done" })],
    ["outcome", (value) => ({ ...value, outcome: "passed" })],
    ["failureKind", (value) => ({ ...value, failureKind: "audit_rejected" })],
    ["attempt", (value) => ({ ...value, attempt: 2 })],
    ["cli", (value) => ({ ...value, cli: "claude" })],
    ["model", (value) => ({ ...value, model: "model-y" })],
    ["startedAt", (value) => ({ ...value, startedAt: "2026-05-01T00:00:02.000Z" })],
    ["endedAt", (value) => ({ ...value, endedAt: "2026-05-01T00:00:03.000Z" })],
  ];

  it.each(taskMutations)("binds task field %s to a changed watermark", (_field, mutate) => {
    const subject = protocol();
    const baseline = task();
    expect(subject.snapshot(snapshot({ tasks: [baseline], taskWatermark: W0 })).ok).toBe(true);
    const changed = mutate(baseline);
    expect(subject.task({ runId: "run_x", projectId: "project_x", tasks: [changed], taskWatermark: W0 }).ok).toBe(
      false,
    );
    expect(subject.task({ runId: "run_x", projectId: "project_x", tasks: [changed], taskWatermark: W1 }).ok).toBe(true);
  });

  it("binds task creation/removal and rejects a watermark change without a projection change", () => {
    const subject = protocol();
    const baseline = task();
    expect(subject.snapshot(snapshot({ tasks: [baseline], taskWatermark: W0 })).ok).toBe(true);
    expect(subject.task({ runId: "run_x", projectId: "project_x", tasks: [baseline], taskWatermark: W1 }).ok).toBe(
      false,
    );
    const created = task({ taskId: "task_write", kind: "write", title: "build it" });
    expect(
      subject.task({ runId: "run_x", projectId: "project_x", tasks: [baseline, created], taskWatermark: W1 }).ok,
    ).toBe(true);
    expect(subject.task({ runId: "run_x", projectId: "project_x", tasks: [], taskWatermark: W2 }).ok).toBe(true);
  });

  it("rejects a task projected under another run even with a fresh watermark", () => {
    const subject = protocol();
    expect(subject.snapshot(snapshot({ tasks: [task()], taskWatermark: W0 })).ok).toBe(true);
    expect(
      subject.task({
        runId: "run_x",
        projectId: "project_x",
        tasks: [task({ runId: "run_other" })],
        taskWatermark: W1,
      }).ok,
    ).toBe(false);
  });
});
