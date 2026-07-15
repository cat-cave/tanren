import { describe, expect, it } from "vitest";
import { settleFromParkOutcome } from "../src/engine/merge/parkSettle.js";
import { RECOVERY_PARK_RETRY_AFTER_MS } from "../src/engine/worker/recoveryParkAtomic.js";

describe("settleFromParkOutcome", () => {
  it("parked with alreadyDequeued skips second dequeue responsibility", () => {
    const s = settleFromParkOutcome(
      { kind: "parked", newlyParked: true, alreadyDequeued: true },
      "msg",
    );
    expect(s).toEqual({
      action: "dequeue",
      reason: "needs_attention",
      message: "msg",
      alreadyDequeued: true,
    });
  });

  it("retained parking_failed never dequeues", () => {
    const s = settleFromParkOutcome(
      {
        kind: "parking_failed",
        reason: "spec_not_recoverable",
        queueDisposition: "retained",
        retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS,
      },
      "msg",
    );
    expect(s.action).toBe("retain");
    if (s.action === "retain") {
      expect(s.retryAfterMs).toBe(RECOVERY_PARK_RETRY_AFTER_MS);
    }
  });

  it("unknown disposition retains for readback/retry", () => {
    const s = settleFromParkOutcome(
      {
        kind: "parking_failed",
        reason: "transport_failed",
        queueDisposition: "unknown",
        retryAfterMs: RECOVERY_PARK_RETRY_AFTER_MS,
      },
      "msg",
    );
    expect(s.action).toBe("retain");
  });
});
