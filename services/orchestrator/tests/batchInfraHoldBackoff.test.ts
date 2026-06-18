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
      expect(result.holdReason).toBe("infra_error");
      delays.push(result.retryAfterMs ?? -1);
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

  it("on SUSTAINED non-recovery emits a TERMINAL alert + a longer backoff (still autonomous, never hot-loop)", async () => {
    const ceiling = new BatchInfraHoldCeiling();
    const events = recordingEmitter();
    // The IDENTICAL failure persisting (no progress) → a fixed point → the terminal alert.
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
    expect(first.holdReason).toBe("infra_error");
    expect(events.blocked.some((e) => e.terminal === true)).toBe(false);

    // The re-drive hits the IDENTICAL failure with no progress → the terminal alert + the
    // longer backoff, but the entries stay queued (autonomous recovery, never hot-loop).
    const last = await holdOnInfra({
      ceiling,
      queue: queueStub,
      events,
      projectId: "p",
      batch,
      message: "persistent 403",
      queueDepth: 1,
    });
    expect(last.holdReason).toBe("infra_error");
    expect(last.retryAfterMs).toBe(INFRA_HOLD_ALERT_RETRY_AFTER_MS);
    expect(events.blocked.some((e) => e.terminal === true)).toBe(true);
  });
});
