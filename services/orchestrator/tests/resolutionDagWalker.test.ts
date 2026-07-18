// cspell:ignore rdec vassert
import { describe, expect, it } from "vitest";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import type { ResolutionJob, ResolutionStage } from "../src/engine/contracts/resolutionStage.js";
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
  attempt: 1,
};

describe("ResolutionDagWalker", () => {
  it("fences, runs, and completes a claimed registered stage", async () => {
    const calls: string[] = [];
    const store = {
      async recoverExpiredLeases() {
        calls.push("recover");
        return [];
      },
      async claimNext() {
        calls.push("claim");
        return job;
      },
      async verifyActiveLease() {
        calls.push("verify");
        return job;
      },
      async heartbeat() {
        calls.push("heartbeat");
        return true;
      },
      async complete() {
        calls.push("complete");
        return true;
      },
      async release() {
        calls.push("release");
        return true;
      },
    } as unknown as ResolutionJobStore;
    const stage: ResolutionStage = {
      kind: "baseline",
      async run(received) {
        calls.push(`run:${received.id}`);
        return {
          outcome: "passed",
          classification: "product_failure",
          proofGrade: "active_causal",
          verificationRunId: "vrun_1",
          assertionIds: [],
          evidenceRefs: [],
        };
      },
    };
    const walker = new ResolutionDagWalker({
      store,
      orgIds: async () => ["org_a"],
      stages: new Map([["baseline", stage]]),
      leaseOwner: "walker_a",
    });

    await expect(walker.tick()).resolves.toEqual([{ orgId: "org_a", recoveredJobIds: [], claimedJobIds: ["rjob_1"] }]);
    expect(calls).toEqual(["recover", "claim", "verify", "run:rjob_1", "complete"]);
  });

  it("returns an inconclusive registered stage to retryable under the same lease", async () => {
    const released: unknown[] = [];
    const store = {
      async recoverExpiredLeases() {
        return [];
      },
      async claimNext() {
        return job;
      },
      async verifyActiveLease() {
        return job;
      },
      async heartbeat() {
        return true;
      },
      async release(input: unknown) {
        released.push(input);
        return true;
      },
      async complete() {
        throw new Error("inconclusive stages must not complete");
      },
    } as unknown as ResolutionJobStore;
    const stage: ResolutionStage = {
      kind: "baseline",
      async run() {
        return {
          outcome: "inconclusive",
          classification: "infra_failure",
          proofGrade: "active_causal",
          verificationRunId: "vrun_1",
          assertionIds: [],
          evidenceRefs: [],
        };
      },
    };
    const walker = new ResolutionDagWalker({
      store,
      orgIds: async () => ["org_a"],
      stages: new Map([["baseline", stage]]),
      leaseOwner: "walker_a",
    });

    await walker.tick();
    expect(released).toEqual([expect.objectContaining({ id: job.id, state: "retryable" })]);
  });

  it("drives the real walker production path through ResolutionAuthority before settlement", async () => {
    const calls: string[] = [];
    const productionJob = { ...job, id: "rjob_production", stage: "production" as const };
    const store = {
      async recoverExpiredLeases() {
        return [];
      },
      async claimNext() {
        return productionJob;
      },
      async verifyActiveLease() {
        return productionJob;
      },
      async heartbeat() {
        return true;
      },
      async complete() {
        calls.push("complete");
        return true;
      },
      async release() {
        return true;
      },
    } as unknown as ResolutionJobStore;
    const walker = new ResolutionDagWalker({
      store,
      orgIds: async () => [productionJob.orgId],
      stages: new Map([
        [
          "production",
          {
            kind: "production" as const,
            async run() {
              calls.push("production-stage");
              return {
                outcome: "failed" as const,
                classification: "product_failure" as const,
                proofGrade: "active_causal" as const,
                verificationRunId: "vrun_cosmetic",
                assertionIds: ["vassert_symptom"],
                evidenceRefs: [],
              };
            },
          },
        ],
      ]),
      authority: {
        async authorize(input) {
          calls.push(`authority:${input.resolutionJobId}`);
          return {
            id: "rdec_blocked",
            decision: "blocked",
            inputSnapshotHash: "sha256:" + "b".repeat(64),
            reasons: ["production symptom verification did not pass"],
            created: true,
          };
        },
        async waive() {
          throw new Error("walker cannot waive a resolution");
        },
      },
      repairRouter: {
        async route(input) {
          calls.push(`repair:${input.resolutionDecisionId}`);
          return {
            kind: "routed",
            created: true,
            projectId: productionJob.projectId,
            issueLoopId: productionJob.issueLoopId,
            remediationAttemptId: "remediation_1",
            specId: "spec_repair_1",
            failureSignatureHash: "sha256:" + "c".repeat(64),
          };
        },
      },
      leaseOwner: "walker_a",
    });

    await walker.tick();
    expect(calls).toEqual(["production-stage", "authority:rjob_production", "repair:rdec_blocked", "complete"]);
  });
});
