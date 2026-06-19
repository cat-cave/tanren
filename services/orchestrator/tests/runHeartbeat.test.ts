import { afterEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat, type HeartbeatMiss, type JobStall } from "../src/engine/worker/runHeartbeat.js";
import { JobProgressSignal } from "../src/engine/worker/jobProgressSignal.js";

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

// PROGRESS-BASED STALL DETECTION (apex-v45): the heartbeat proves the worker thread is ALIVE;
// it does NOT prove the job makes forward PROGRESS. A job WEDGED on a non-resolving await keeps
// heartbeating while making ZERO progress (the apex-v45 hang sat for hours, lease always fresh).
// When a JobProgressSignal is wired, the heartbeat renews UNBOUNDED while the signal advances,
// but STOPS renewing (lease lapses -> reaper recovers) once the signal is FIXED for the lease
// window. PROGRESS-based, never a wall-clock kill: a job that advances the signal is untouched.
describe("startHeartbeat -- progress-based stall detection", () => {
  it("a job whose progress signal ADVANCES every beat renews UNBOUNDED and never stalls", async () => {
    vi.useFakeTimers();
    const stalls: JobStall[] = [];
    const signal = new JobProgressSignal();
    const heartbeat = vi.fn<() => Promise<void>>(async () => {});
    const stop = startHeartbeat({
      heartbeat,
      jobId: "job_working",
      leaseMs: 60_000,
      intervalMs: 15_000,
      progressSignal: signal,
      onStall: (st) => stalls.push(st),
    });

    // Forward motion before every beat (a working job hits SSH boundaries continuously) -- far
    // beyond the lease window. The signal advances each beat, so the job is never flagged.
    for (let i = 0; i < 12; i += 1) {
      signal.tick();
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(stalls).toEqual([]);
    // Every beat renewed the lease -- a working job is renewed unbounded.
    expect(heartbeat.mock.calls.length).toBe(12);
    await stop();
  });

  it("a job that HEARTBEATS but makes NO forward progress for the lease window is detected + stops renewing", async () => {
    vi.useFakeTimers();
    const stalls: JobStall[] = [];
    const signal = new JobProgressSignal();
    // Some real progress first (the job ran for a while), THEN it WEDGES -- the signal goes flat.
    signal.tick();
    signal.tick();
    signal.tick();
    const heartbeat = vi.fn<() => Promise<void>>(async () => {});
    const stop = startHeartbeat({
      heartbeat,
      jobId: "job_wedged",
      leaseMs: 60_000,
      // lease 60s / interval 15s -> 4 beats per lease -> stall at the 4th flat beat.
      intervalMs: 15_000,
      progressSignal: signal,
      onStall: (st) => stalls.push(st),
    });

    // NO ticks from here on -- the job is wedged on a non-resolving await. Drive past the window.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    // Detected exactly once: the signal did not advance for the whole lease window (4 beats).
    expect(stalls.length).toBe(1);
    expect(stalls[0]?.jobId).toBe("job_wedged");
    expect(stalls[0]?.nonAdvancingBeats).toBe(4);
    expect(stalls[0]?.progressValue).toBe(3);
    // The heartbeat STOPPED renewing once wedged: the 4th beat detected the stall and did NOT
    // renew, so the lease lapses and the reaper recovers. At most 3 renewals (the flat beats
    // before detection), then none -- never the 5 beats the loop would otherwise have made.
    expect(heartbeat.mock.calls.length).toBeLessThanOrEqual(3);
    await stop();
  });

  it("a near-stall that RESUMES progress before the window resets and is never flagged", async () => {
    vi.useFakeTimers();
    const stalls: JobStall[] = [];
    const signal = new JobProgressSignal();
    const stop = startHeartbeat({
      heartbeat: async () => {},
      jobId: "job_slow",
      leaseMs: 60_000,
      intervalMs: 15_000,
      progressSignal: signal,
      onStall: (st) => stalls.push(st),
    });

    // Three flat beats (no progress) -- just short of the 4-beat window -- then a tick resumes.
    await vi.advanceTimersByTimeAsync(45_000);
    signal.tick();
    // Several more beats with periodic progress -- never reaches a full flat window.
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      if (i % 2 === 0) signal.tick();
    }
    expect(stalls).toEqual([]);
    await stop();
  });

  it("with NO progress signal wired, the heartbeat renews unconditionally (behavior-identical)", async () => {
    vi.useFakeTimers();
    const stalls: JobStall[] = [];
    const heartbeat = vi.fn<() => Promise<void>>(async () => {});
    const stop = startHeartbeat({
      heartbeat,
      jobId: "job_unsignaled",
      leaseMs: 60_000,
      intervalMs: 15_000,
      onStall: (st) => stalls.push(st),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    // No signal -> no stall detection -> renews every beat exactly as before.
    expect(stalls).toEqual([]);
    expect(heartbeat.mock.calls.length).toBe(8);
    await stop();
  });
});
