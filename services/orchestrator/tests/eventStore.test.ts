import { describe, expect, it } from "vitest";
import { FakeEventStore } from "../src/engine/eventStore.js";
import { listEventNames } from "../src/engine/events.js";

describe("event store", () => {
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
    expect(listEventNames()).toContain("planner.completed");
  });

  it("rejects undeclared event names", async () => {
    const store = new FakeEventStore();

    await expect(
      store.append({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        eventType: "made_up.event",
        payload: {}
      })
    ).rejects.toThrow("undeclared event name");
  });
});
