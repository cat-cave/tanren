// apex-v35 VOLUME guard: the batch infra-hold re-drive backs off EXPONENTIALLY across
// consecutive holds (3s → 10s → 30s → 60s) instead of a fixed ~3s hammer, so a persistent
// upstream 403 (the secondary-rate-limit case) does not sustain itself with re-drive volume.

import { describe, expect, it } from "vitest";
import {
  BatchInfraHoldCeiling,
  holdOnInfra,
  INFRA_HOLD_ALERT_RETRY_AFTER_MS,
} from "../src/engine/merge/batchInfraHoldCeiling.js";
import { RECOVERABLE_RETRY_DELAYS_MS } from "../src/engine/merge/retrySchedule.js";
import type { BatchMergeEventEmitter } from "../src/engine/merge/batchCoordinator.js";
import type { MergeQueueEntry, MergeQueueModel } from "../src/engine/contracts/mergeCoordinator.js";

/** A no-op emitter that records the emitted infra_blocked events. */
function recordingEmitter(): BatchMergeEventEmitter & { blocked: Array<{ terminal?: boolean }> } {
  const blocked: Array<{ terminal?: boolean }> = [];
  return {
    blocked,
    emitChecking: async () => {},
    emitPassed: async () => {},
    emitBisecting: async () => {},
    emitCulpritSetIdentified: async () => {},
    emitBehaviorFailed: async () => {},
    emitInfraBlocked: async (input) => void blocked.push({ terminal: input.terminal }),
  };
}

/** A queue stub — `holdOnInfra` only calls `markDequeued` on the terminal-block path. */
const queueStub = { markDequeued: async () => {} } as unknown as MergeQueueModel;

const batch: ReadonlyArray<MergeQueueEntry> = [];

describe("batch infra-hold exponential backoff (apex-v35)", () => {
  it("grows the recoverable re-drive delay across SHIFTING holds (3s → 10s → 30s → 60s)", async () => {
    const ceiling = new BatchInfraHoldCeiling();
    const events = recordingEmitter();
    const delays: number[] = [];
    // A SHIFTING outage (each hold a different failure) stays on the RECOVERABLE curve — it
    // is progress, never sustained-non-recovery, so it exercises the exponential backoff.
    for (let i = 0; i < 4; i += 1) {
      const result = await holdOnInfra({
        ceiling,
        queue: queueStub,
        events,
        projectId: "p",
        batch,
        message: `GitHub ref read for main failed: HTTP 403 variant ${i} (secondary-rate-limit)`,
        queueDepth: 1,
      });
      // A shifting outage keeps recovering — every hold stays on the recoverable branch.
      expect(result.kind).toBe("hold");
      if (result.kind !== "hold") throw new Error("unreachable");
      expect(result.result.holdReason).toBe("infra_error");
      delays.push(result.result.retryAfterMs ?? -1);
    }
    // EXPONENTIAL, not a fixed 3s hammer — exactly the single-source recoverable curve.
    expect(delays).toEqual([...RECOVERABLE_RETRY_DELAYS_MS]);
    // Strictly increasing (the property the fix guarantees; a fixed interval would be flat).
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
    // A shifting failure is progress — it must NEVER emit the terminal non-recovery alert.
    expect(events.blocked.every((e) => e.terminal !== true)).toBe(true);
  });

  it("on SUSTAINED non-recovery returns the ESCALATE verdict (v54 #56 — caller routes to writer rework)", async () => {
    const ceiling = new BatchInfraHoldCeiling();
    const events = recordingEmitter();
    // The IDENTICAL failure persisting (no progress) → a fixed point.
    const first = await holdOnInfra({
      ceiling,
      queue: queueStub,
      events,
      projectId: "p",
      batch,
      message: "persistent 403",
      queueDepth: 1,
    });
    // The first hold is recoverable — one failure is not yet proof of non-recovery.
    expect(first.kind).toBe("hold");
    if (first.kind !== "hold") throw new Error("unreachable");
    expect(first.result.holdReason).toBe("infra_error");

    // The re-drive hits the IDENTICAL failure with no progress → escalate verdict. No
    // terminal event emitted from `holdOnInfra` itself — the escalator (the caller) emits
    // the loud `disposition: escalated_to_writer` event and routes the dequeue cascade.
    const last = await holdOnInfra({
      ceiling,
      queue: queueStub,
      events,
      projectId: "p",
      batch,
      message: "persistent 403",
      queueDepth: 1,
    });
    expect(last.kind).toBe("escalate");
    if (last.kind !== "escalate") throw new Error("unreachable");
    expect(last.holds).toBeGreaterThan(1);
    // INFRA_HOLD_ALERT_RETRY_AFTER_MS no longer flows through this branch (no backoff loop).
    expect(INFRA_HOLD_ALERT_RETRY_AFTER_MS).toBeGreaterThan(0);
  });
});
