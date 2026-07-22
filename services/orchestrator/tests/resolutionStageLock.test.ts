// bh-15 DB-free negative controls: BOTH resolution stages consume ONLY the locked
// behavior context. An empty/unlocked invocation fails closed IMMEDIATELY — before
// any DB, probe, or hash work — so a stage can never re-prove against an ad-hoc or
// unbound behavior identity (no self-computed runtimeContextHash substitute).
import { describe, expect, it } from "vitest";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import { BaselineReproductionStage } from "../src/engine/verification/resolutionStages/baselineReproductionStage.js";
import { ProductionSymptomStage } from "../src/engine/verification/resolutionStages/productionSymptomStage.js";
import { LockedBehaviorContextError } from "../src/engine/verification/resolutionStages/resolutionBehaviorContext.js";

function job(stage: "baseline" | "production"): ResolutionJob {
  return {
    id: `rjob_${stage}`,
    orgId: "org_lock",
    projectId: "project_lock",
    issueLoopId: "iloop_lock",
    contractId: "contract_lock",
    releaseInstanceId: "release_lock",
    stage,
    state: "running",
    leaseOwner: "worker_lock",
    leaseExpiry: "2026-01-01T00:01:00.000Z",
    idempotencyKey: `iloop_lock:${stage}`,
    attempt: 1,
  };
}

describe("bh-15 stage lock (empty context fails closed)", () => {
  it("ProductionSymptomStage.run(job, {}) fails closed without probing or computing a substitute hash", async () => {
    let contractReads = 0;
    let verifications = 0;
    const stage = new ProductionSymptomStage({
      pool: {} as never,
      contracts: {
        get: async () => {
          contractReads += 1;
          throw new Error("contract read must not run on an unlocked invocation");
        },
      },
      probe: {
        runVerification: async () => {
          verifications += 1;
          throw new Error("probe must not run on an unlocked invocation");
        },
      },
    });
    await expect(stage.run(job("production"), {})).rejects.toBeInstanceOf(LockedBehaviorContextError);
    await expect(stage.run(job("production"), {})).rejects.toMatchObject({ reason: "unlocked_context" });
    // Fail-closed FIRST: neither the contract read nor the probe ran.
    expect(contractReads).toBe(0);
    expect(verifications).toBe(0);
  });

  it("BaselineReproductionStage.run(job, {}) fails closed without resolving context or probing", async () => {
    let contractReads = 0;
    let resolves = 0;
    let probes = 0;
    const stage = new BaselineReproductionStage({
      pool: {} as never,
      contracts: {
        get: async () => {
          contractReads += 1;
          throw new Error("contract read must not run on an unlocked invocation");
        },
      },
      contextResolver: {
        resolve: async () => {
          resolves += 1;
          throw new Error("resolver must not run on an unlocked invocation");
        },
      },
      probe: {
        runBaseline: async () => {
          probes += 1;
          throw new Error("probe must not run on an unlocked invocation");
        },
      },
    });
    await expect(stage.run(job("baseline"), {})).rejects.toBeInstanceOf(LockedBehaviorContextError);
    await expect(stage.run(job("baseline"), {})).rejects.toMatchObject({ reason: "unlocked_context" });
    expect(contractReads).toBe(0);
    expect(resolves).toBe(0);
    expect(probes).toBe(0);
  });
});
