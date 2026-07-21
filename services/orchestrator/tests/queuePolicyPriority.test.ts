import { describe, expect, it } from "vitest";
import { effectiveQueuePriority } from "../src/engine/merge/queuePolicyPriority.js";

describe("QueuePolicyV1 deterministic aging comparator", () => {
  it("promotes only after later admissions, never because wall-clock time elapsed", () => {
    const snapshot = { priority: "P2", aging: { enabled: true, step: 2 } };
    expect(effectiveQueuePriority({ snapshot, override: null, laterEntries: 1 })).toBe("P2");
    expect(effectiveQueuePriority({ snapshot, override: null, laterEntries: 2 })).toBe("P1");
    expect(effectiveQueuePriority({ snapshot, override: null, laterEntries: 4 })).toBe("P0");
  });

  it("honors an explicit validated boost and rejects malformed snapshot coordinates", () => {
    expect(
      effectiveQueuePriority({
        snapshot: { priority: "P2", aging: { enabled: false, step: 1 } },
        override: "P0",
        laterEntries: 0,
      }),
    ).toBe("P0");
    expect(() => effectiveQueuePriority({ snapshot: { priority: "P1" }, override: null, laterEntries: 0 })).toThrow(
      "priority snapshot",
    );
  });
});
