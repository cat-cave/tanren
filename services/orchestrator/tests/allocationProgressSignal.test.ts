// The allocation/readiness phase precedes every SSH boundary. Its returned
// readiness observations must therefore advance the same job-progress signal
// the heartbeat uses, or a healthy slow provision would be requeued and run twice.

import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator, RunnerAllocation } from "../src/engine/contracts/allocator.js";
import { FakeJobQueue, type ReapedJob } from "../src/engine/contracts/jobQueue.js";
import { pollUntilReady, type ReadinessClassification } from "../src/engine/allocators/readinessConvergence.js";
import { executeNextPlanJob } from "../src/engine/worker/index.js";
import { delay, deps, enqueuePlanJob, passingGitHub, setupSeededRun, target } from "./helpers/workerExec.js";

interface ReadinessObservation {
  ready: boolean;
}

function classifyReadiness(observation: ReadinessObservation): ReadinessClassification<ReadinessObservation> {
  return observation.ready ? { kind: "ready", observation } : { kind: "advancing", observation };
}

class SlowReadinessAllocator implements Allocator {
  readonly taxonomy = "provisioning" as const;
  readonly reaperPasses: ReapedJob[][] = [];
  private probes = 0;

  constructor(private readonly jobQueue: FakeJobQueue) {}

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    await pollUntilReady(
      async () => {
        if (this.probes > 0) {
          this.reaperPasses.push(await this.jobQueue.reapExpiredLeases());
        }
        await delay(20);
        this.probes += 1;
        // Five non-ready observations plus the ready observation take 120 ms:
        // twice this test's 60 ms wedge window, with real progress throughout.
        return { ready: this.probes === 6 };
      },
      {
        classify: classifyReadiness,
        signature: (observation) => (observation.ready ? "ready" : "pending"),
        pollIntervalMs: 0,
        sleep: async () => {},
        onProbe: () => request.onProgress?.(),
      },
    );
    return { runnerId: "runner_slow_readiness", imageSha: "sha256:slow-readiness", target };
  }

  async release(): Promise<void> {}
}

describe("allocation readiness progress", () => {
  it("does not wedge or requeue a run whose provisioning exceeds the lease window", async () => {
    const { pool, secrets, run } = await setupSeededRun();
    const jobQueue = new FakeJobQueue();
    await enqueuePlanJob(jobQueue, run);
    const allocator = new SlowReadinessAllocator(jobQueue);
    const stalls: string[] = [];

    const result = await executeNextPlanJob({
      ...deps(pool, secrets, jobQueue, passingGitHub()),
      allocator,
      leaseMs: 60,
      heartbeatIntervalMs: 15,
      onJobStall: (stall) => stalls.push(stall.jobId),
    });

    expect(result).toMatchObject({ kind: "completed", runId: run.runId });
    expect(allocator.reaperPasses).toHaveLength(5);
    expect(allocator.reaperPasses.every((reaped) => reaped.length === 0)).toBe(true);
    expect(stalls).toEqual([]);
  });
});
