import { describe, expect, it } from "vitest";
import { WorkerClaimMonitor, type PreClaimObservation } from "./stack-worker.js";

const base: PreClaimObservation = {
  targetQueueId: 10,
  targetStatus: "queued",
  targetAttempts: 0,
  targetHeartbeatAtMs: null,
  enqueuedAtMs: 1_000,
  databaseNowMs: 1_500,
  workerContainerId: "worker-a",
  workerRunning: true,
  workerStatus: "running",
};

describe("worker pre-claim liveness", () => {
  it("accepts the exact worker claiming or finalizing the target", () => {
    const monitor = new WorkerClaimMonitor({ expectedWorkerContainerId: "worker-a" });
    expect(monitor.observe({ ...base, targetStatus: "running", targetAttempts: 1 })).toBe("claimed");
    expect(monitor.observe({ ...base, targetStatus: "done", targetAttempts: 1 })).toBe("finalized");
  });

  it("rejects zero-attempt terminal claims and unsupported queue states", () => {
    const monitor = new WorkerClaimMonitor({ expectedWorkerContainerId: "worker-a" });
    expect(() => monitor.observe({ ...base, targetStatus: "done" })).toThrow(/durable claim attempt/u);
    expect(() => monitor.observe({ ...base, targetStatus: "mystery", targetAttempts: 1 })).toThrow(
      /unsupported status/u,
    );
  });

  it("requires Running and Status consistency and rejects replacements", () => {
    const monitor = new WorkerClaimMonitor({ expectedWorkerContainerId: "worker-a" });
    expect(() => monitor.observe({ ...base, workerRunning: false, workerStatus: "running" })).toThrow(
      /not consistently running/u,
    );
    expect(() => monitor.observe({ ...base, workerRunning: true, workerStatus: "exited" })).toThrow(
      /not consistently running/u,
    );
    expect(() => monitor.observe({ ...base, workerContainerId: "worker-b" })).toThrow(/replaced/u);
  });

  it("never treats concurrent later queue ids as target progress", () => {
    const monitor = new WorkerClaimMonitor({ expectedWorkerContainerId: "worker-a" });
    // Observation shape has no later-id field; progress is only target-local.
    expect(monitor.observe(base)).toBe("queued");
    expect(() => monitor.observe({ ...base, databaseNowMs: 9_999 })).toThrow(
      /no target-specific durable claim progress/u,
    );
  });

  it("converges on target-specific durable claim progress and rejects contradictory state", () => {
    const monitor = new WorkerClaimMonitor({ expectedWorkerContainerId: "worker-a" });
    expect(monitor.observe(base)).toBe("queued");
    expect(
      monitor.observe({
        ...base,
        targetAttempts: 1,
        targetHeartbeatAtMs: 2_000,
      }),
    ).toBe("queued");
    expect(monitor.observe({ ...base, targetStatus: "claimed", targetAttempts: 1 })).toBe("claimed");
    expect(() =>
      monitor.observe({
        ...base,
        targetStatus: "queued",
        workerRunning: true,
        workerStatus: "dead",
      }),
    ).toThrow(/not consistently running/u);
  });
});
