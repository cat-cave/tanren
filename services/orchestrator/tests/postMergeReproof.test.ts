// rv-19 DB-less unit coverage for the production re-proof deploy-settlement seam.
// The decisive rollback-reverts / promote / idempotency / RLS behavior is proven on
// the live substrate in postMergeReproof.rls.integration.test.ts; this file pins the
// pure stage-gating of `applyReproofDeployOutcome` (a no-op for every non-production
// stage; fail-closed on a production job with no release binding).
import { describe, expect, it } from "vitest";
import {
  applyReproofDeployOutcome,
  PostMergeReproofBindingError,
  type ReproofDeployDecision,
  type SettleReproofInput,
} from "../src/engine/verification/postMergeReproof/coordinator.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";

const PRODUCTION_FAILURE = {
  proofGrade: "active_causal",
  verificationRunId: "vrun_1",
  assertionIds: ["a1"],
  evidenceRefs: ["e1"],
  outcome: "failed",
  classification: "product_failure",
} as const;

function recordingCoordinator(decision: ReproofDeployDecision): {
  settle(input: SettleReproofInput): Promise<ReproofDeployDecision>;
  calls: SettleReproofInput[];
} {
  const calls: SettleReproofInput[] = [];
  return {
    calls,
    settle(input: SettleReproofInput): Promise<ReproofDeployDecision> {
      calls.push(input);
      return Promise.resolve(decision);
    },
  };
}

function job(overrides: Partial<ResolutionJob>): ResolutionJob {
  return {
    id: "rjob_1",
    orgId: "org_1",
    projectId: "project_1",
    issueLoopId: "loop_1",
    contractId: "contract_1",
    stage: "production",
    state: "running",
    leaseOwner: "owner_1",
    leaseExpiry: "2026-07-18T00:00:00.000Z",
    idempotencyKey: "idem_1",
    attempt: 1,
    releaseInstanceId: "release_1",
    ...overrides,
  };
}

describe("applyReproofDeployOutcome — production-stage settlement gating", () => {
  it("routes a production job with a release binding to the coordinator", async () => {
    const coordinator = recordingCoordinator("rolled_back");
    const decision = await applyReproofDeployOutcome(coordinator, job({}), PRODUCTION_FAILURE);
    expect(decision).toBe("rolled_back");
    expect(coordinator.calls).toHaveLength(1);
    expect(coordinator.calls[0]?.releaseInstanceId).toBe("release_1");
  });

  it("is a no-op for a non-production stage (baseline never touches the deploy pointer)", async () => {
    const coordinator = recordingCoordinator("rolled_back");
    const decision = await applyReproofDeployOutcome(coordinator, job({ stage: "baseline" }), PRODUCTION_FAILURE);
    expect(decision).toBeUndefined();
    expect(coordinator.calls).toHaveLength(0);
  });

  it("is a no-op when no coordinator is wired", async () => {
    const decision = await applyReproofDeployOutcome(undefined, job({}), PRODUCTION_FAILURE);
    expect(decision).toBeUndefined();
  });

  it("fails closed when a production job carries no release binding", async () => {
    const coordinator = recordingCoordinator("rolled_back");
    await expect(
      applyReproofDeployOutcome(coordinator, job({ releaseInstanceId: undefined }), PRODUCTION_FAILURE),
    ).rejects.toBeInstanceOf(PostMergeReproofBindingError);
    expect(coordinator.calls).toHaveLength(0);
  });
});
