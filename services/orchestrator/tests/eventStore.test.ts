import { describe, expect, it } from "vitest";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { listEventNames } from "../src/engine/events.js";

describe("event store (legacy shim)", () => {
  it("re-exports listEventNames from the registry barrel", () => {
    expect(listEventNames()).toContain("planner.completed");
  });

  it("accepts declared event names", async () => {
    const store = new FakeEventStore();

    await store.append({
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      eventType: "hello.started",
      payload: {}
    });

    expect(store.events).toHaveLength(1);
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
        payload: {} as never
      })
    ).rejects.toThrow("undeclared event name");
  });
});
