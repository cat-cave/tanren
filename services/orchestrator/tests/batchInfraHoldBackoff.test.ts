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
    emitCulprit: async () => {},
    emitInfraBlocked: async (input) => void blocked.push({ terminal: input.terminal }),
  };
}

/** A queue stub — `holdOnInfra` only calls `markDequeued` on the terminal-block path. */
const queueStub = { markDequeued: async () => {} } as unknown as MergeQueueModel;

const batch: ReadonlyArray<MergeQueueEntry> = [];

describe("batch infra-hold exponential backoff (apex-v35)", () => {
  it("grows the re-drive delay across consecutive holds (3s → 10s → 30s → 60s), bounded", async () => {
    const ceiling = new BatchInfraHoldCeiling();
    const events = recordingEmitter();
    const delays: number[] = [];
    // MAX_BATCH_INFRA_HOLDS = 5 → holds 1..4 are recoverable; the 5th hits the ceiling.
    for (let i = 0; i < 4; i += 1) {
      const result = await holdOnInfra({
        ceiling,
        queue: queueStub,
        events,
        projectId: "p",
        batch,
        message: "GitHub ref read for main failed: HTTP 403 (secondary-rate-limit)",
        queueDepth: 1,
      });
      expect(result.holdReason).toBe("infra_error");
      delays.push(result.retryAfterMs ?? -1);
    }
    // EXPONENTIAL, not a fixed 3s hammer — exactly the single-source recoverable curve.
    expect(delays).toEqual([...RECOVERABLE_RETRY_DELAYS_MS]);
    // Strictly increasing (the property the fix guarantees; a fixed interval would be flat).
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
    expect(events.blocked.every((e) => e.terminal !== true)).toBe(true);
  });

  it("at the ceiling emits a TERMINAL alert + a longer backoff (still autonomous, never hot-loop)", async () => {
    const ceiling = new BatchInfraHoldCeiling();
    const events = recordingEmitter();
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await holdOnInfra({
        ceiling,
        queue: queueStub,
        events,
        projectId: "p",
        batch,
        message: "persistent 403",
        queueDepth: 1,
      });
    }
    expect(last?.holdReason).toBe("infra_error");
    expect(last?.retryAfterMs).toBe(INFRA_HOLD_ALERT_RETRY_AFTER_MS);
    expect(events.blocked.some((e) => e.terminal === true)).toBe(true);
  });
});
