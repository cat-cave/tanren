import { describe, expect, it } from "vitest";
import { registeredStages, ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import type { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";

const job: ResolutionJob = {
  id: "rjob_1",
  orgId: "org_a",
  projectId: "project_a",
  issueLoopId: "iloop_a",
  contractId: "contract_a",
  stage: "baseline",
  state: "running",
  leaseOwner: "walker_a",
  leaseExpiry: "2026-01-01T00:01:00.000Z",
  idempotencyKey: "iloop_a:baseline",
  attempt: 2,
};

describe("ResolutionDagWalker skeleton", () => {
  it("recovers an expired lease, heartbeats it, and releases it without running a stage", async () => {
    const calls: string[] = [];
    const store = {
      async recoverExpiredLeases() {
        calls.push("recover");
        return [job];
      },
      async claimNext() {
        calls.push("claim");
      },
      async heartbeat() {
        calls.push("heartbeat");
        return true;
      },
      async release() {
        calls.push("release");
        return true;
      },
    } as unknown as ResolutionJobStore;
    const walker = new ResolutionDagWalker({ store, orgIds: async () => ["org_a"], leaseOwner: "walker_a" });

    await expect(walker.tick()).resolves.toEqual([{ orgId: "org_a", recoveredJobIds: ["rjob_1"], claimedJobIds: [] }]);
    expect(calls).toEqual(["recover", "heartbeat", "release"]);
    expect(registeredStages).toHaveLength(0);
  });
});
