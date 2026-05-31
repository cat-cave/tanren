import { describe, expect, it } from "vitest";
import { listEventNames } from "../src/engine/events/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

describe("typed event store", () => {
  it("accepts a payload whose shape matches the registered Zod schema", async () => {
    const store = new FakeEventStore();
    await store.append({
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      eventType: "hello.started",
      payload: {},
    });
    await store.append({
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      eventType: "checker.verdict",
      payload: {
        runId: "run_1",
        taskId: "task_1",
        subtaskIndex: 0,
        passed: true,
        reasoning: "criteria satisfied",
        behaviorIdsPassed: ["B1"],
        behaviorIdsFailed: [],
      },
    });
    expect(store.events).toHaveLength(2);
    expect(store.events[1]?.payload).toMatchObject({ passed: true, behaviorIdsPassed: ["B1"] });
  });

  it("rejects payloads that violate the schema", async () => {
    const store = new FakeEventStore();
    await expect(
      store.append({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        eventType: "checker.verdict",
        // Missing fields — Zod must reject.
        payload: { passed: true } as never,
      }),
    ).rejects.toThrow(/invalid|required|expected/iu);
  });

  it("rejects undeclared event names", async () => {
    const store = new FakeEventStore();
    await expect(
      store.append({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventType: "made_up.event" as never,
        payload: {} as never,
      }),
    ).rejects.toThrow("undeclared event name");
  });

  it("listEventNames returns the full registered set", () => {
    const names = listEventNames();
    expect(names).toContain("planner.completed");
    expect(names).toContain("writer.subtask.completed");
    expect(names).toContain("auditor.verdict");
  });

  it("strips extraneous keys via Zod strict parsing", async () => {
    const store = new FakeEventStore();
    await expect(
      store.append({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        eventType: "run.started",
        payload: { status: "running", extra: "no" } as never,
      }),
    ).rejects.toThrow(/unrecognized|extra|strict/iu);
  });
});
