// Seam conformance suite for the EventStore contract
// (`engine/eventStore.ts`). Reusable behavior spec invoked once per
// implementation via `describeEventStoreConformance`. Asserts the append +
// read-back contract through the public API and observable state only: events
// are appended and read back in append order (the single-writer ordering
// contract), and undeclared event names are rejected. Because read-back is not
// part of the `EventStore` interface (the Pg impl writes to a table; the fake
// keeps an array), the harness supplies an impl-specific `readBack()` that
// observes the appended events in order — the spec never touches private
// fields. Track C §2 of docs/architecture/portability-and-longevity.md.
import { describe, expect, it } from "vitest";
import type { EventStore } from "../../src/engine/eventStore.js";

export interface ObservedEvent {
  runId: string;
  specId: string;
  projectId: string;
  eventType: string;
}

export interface EventStoreConformanceHarness {
  /**
   * Build a fresh, empty EventStore plus an observer that reads the appended
   * events back IN APPEND ORDER. The observer is the only impl-specific seam;
   * everything else is asserted through the public `append` contract.
   */
  make(): { store: EventStore; readBack(): Promise<ObservedEvent[]> };
}

const base = { specId: "spec_1", projectId: "project_1" } as const;

/**
 * Behavior spec every EventStore implementation must pass. Call once per impl:
 *
 *   describeEventStoreConformance("FakeEventStore", { make: () => { ... } });
 */
export function describeEventStoreConformance(label: string, harness: EventStoreConformanceHarness): void {
  describe(`EventStore conformance: ${label}`, () => {
    it("appends a declared event and reads it back", async () => {
      const { store, readBack } = harness.make();
      await store.append({ runId: "run_1", eventType: "hello.started", payload: {}, ...base });
      const events = await readBack();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runId: "run_1", eventType: "hello.started" });
    });

    it("reads events back in append order (single-writer ordering contract)", async () => {
      const { store, readBack } = harness.make();
      await store.append({ runId: "run_a", eventType: "hello.started", payload: {}, ...base });
      await store.append({ runId: "run_b", eventType: "hello.started", payload: {}, ...base });
      await store.append({ runId: "run_c", eventType: "hello.started", payload: {}, ...base });
      const order = (await readBack()).map((event) => event.runId);
      expect(order).toEqual(["run_a", "run_b", "run_c"]);
    });

    it("rejects an undeclared event name (the append never lands)", async () => {
      const { store, readBack } = harness.make();
      await expect(
        store.append({
          runId: "run_1",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          eventType: "totally.madeup" as never,
          payload: {} as never,
          ...base
        })
      ).rejects.toThrow(Error);
      // A rejected append must not have been recorded.
      await expect(readBack()).resolves.toHaveLength(0);
    });
  });
}
