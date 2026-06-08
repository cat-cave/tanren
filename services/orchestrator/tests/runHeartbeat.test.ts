import { afterEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat, type HeartbeatMiss } from "../src/engine/worker/runHeartbeat.js";

// Silent-fallback hardening (finding 9): a heartbeat miss is no longer silently
// swallowed. Every miss is COUNTED + surfaced, the count RESETS on a success, and
// once the consecutive misses consume the lease window the `atRisk` flag flips
// (the reaper may now requeue a still-running job → duplicate execution).

afterEach(() => {
  vi.useRealTimers();
});

describe("startHeartbeat — loud miss accounting", () => {
  it("counts consecutive misses, flips atRisk once they consume the lease window, and resets on success", async () => {
    vi.useFakeTimers();
    const misses: HeartbeatMiss[] = [];
    // lease 60s / interval 15s → 4 beats per lease → atRisk at the 4th miss.
    let failNext = true;
    const heartbeat = vi.fn<() => Promise<void>>(async () => {
      if (failNext) {
        throw new Error("db blip");
      }
    });
    const stop = startHeartbeat({
      heartbeat,
      jobId: "job_1",
      leaseMs: 60_000,
      intervalMs: 15_000,
      onMiss: (m) => misses.push(m),
    });

    // Drive 4 consecutive failing beats.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(misses.map((m) => m.consecutiveMisses)).toEqual([1, 2, 3, 4]);
    // EVERY miss is surfaced; atRisk flips ONLY once the streak consumed the lease.
    expect(misses.map((m) => m.atRisk)).toEqual([false, false, false, true]);
    expect(misses.every((m) => m.detail === "db blip")).toBe(true);

    // A success resets the consecutive-miss counter.
    failNext = false;
    await vi.advanceTimersByTimeAsync(15_000);
    failNext = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(misses.at(-1)?.consecutiveMisses).toBe(1);
    expect(misses.at(-1)?.atRisk).toBe(false);

    await stop();
  });

  it("never fires a miss when every beat succeeds", async () => {
    vi.useFakeTimers();
    const misses: HeartbeatMiss[] = [];
    const stop = startHeartbeat({
      heartbeat: async () => {},
      jobId: "job_ok",
      leaseMs: 60_000,
      intervalMs: 15_000,
      onMiss: (m) => misses.push(m),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(misses).toEqual([]);
    await stop();
  });
});
