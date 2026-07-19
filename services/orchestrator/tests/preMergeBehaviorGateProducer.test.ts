// rv-premerge — DB-less unit proof of the pre-merge behavior-gate producer's fail-closed
// decision table + teardown discipline. The producer drives the REAL rv-11 flow through an
// injected executor/provisioner here; the *.rls.integration test proves the real rv-11
// orchestrator + PgAcceptanceRunStore + resolveLandTimeBehaviorGate chain end-to-end.

import { describe, expect, it, vi } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import type {
  AcceptancePlan,
  AcceptancePlanLoader,
  AcceptanceRunRequest,
  AcceptanceRunResult,
} from "../src/engine/verification/acceptance/index.js";
import {
  PreviewBehaviorGateProducer,
  type AcceptanceExecutor,
  type PreMergeBehaviorGateInput,
  type PreviewProvisionResult,
  type PreviewSurface,
  type PreviewSurfaceProvisioner,
} from "../src/engine/verification/preMerge/preMergeBehaviorGateProducer.js";
import type { BehaviorVerdictOutcome } from "../src/engine/contracts/runtimeVerificationAdapters.js";

const CAS = `sha256:${"a".repeat(64)}` as Digest;

const INPUT: PreMergeBehaviorGateInput = {
  orgId: "org1",
  projectId: "proj1",
  runId: "run1",
  specId: "spec1",
  repoUrl: "https://github.com/acme/web.git",
  headSha: "deadbeef",
  behaviorRevisionIds: ["br1"],
};

const SURFACE: PreviewSurface = {
  deploymentId: "dep1",
  url: "https://preview.example.test",
  integrationNodeId: "run1",
  artifactDigest: CAS,
  environmentId: "venv1",
};

function fakePlan(): AcceptancePlan {
  return {
    planId: "plan1",
    behaviorRevisionId: "br1",
    requiredSurfaces: ["api"],
    assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
    fixtures: [],
    examples: [],
    executionMatrix: { browser: [], viewport: [], locale: [], theme: [], motion: [], contrast: [], device: [] },
    causes: [],
    httpProbes: [{ probeId: "p1", method: "GET", path: "/" }],
  };
}

function planLoaderReturning(plans: readonly AcceptancePlan[]): AcceptancePlanLoader {
  return { loadPlans: async () => plans };
}

function planLoaderThrowing(): AcceptancePlanLoader {
  return {
    loadPlans: async () => {
      throw new Error("malformed acceptance spec");
    },
  };
}

function executorWithOutcome(outcome: BehaviorVerdictOutcome): AcceptanceExecutor {
  return {
    async execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult> {
      expect(request.purpose).toBe("pre_merge");
      expect(request.externalRunId).toBe("run1");
      expect(request.environmentId).toBe("venv1");
      return {
        runId: "vr1",
        requiredVerdictCount: 1,
        passedVerdictCount: outcome === "passed" ? 1 : 0,
        runtimeBehaviorContextHash: CAS,
        behaviors: [
          {
            behaviorRevisionId: "br1",
            planId: "plan1",
            verdictId: "vd1",
            outcome,
            requiredAssertionCount: 1,
            executedAssertionCount: 1,
            passedAssertionCount: outcome === "passed" ? 1 : 0,
          },
        ],
      };
    },
  };
}

function provisionerReturning(
  result: PreviewProvisionResult,
  teardown = vi.fn<PreviewSurfaceProvisioner["teardown"]>(async () => {}),
): { provisioner: PreviewSurfaceProvisioner; teardown: ReturnType<typeof vi.fn> } {
  return {
    teardown,
    provisioner: { provision: async () => result, teardown },
  };
}

describe("PreviewBehaviorGateProducer — fail-closed decision table", () => {
  it("no declared behaviors → not_applicable (never deploys a preview)", async () => {
    const provision = vi.fn<PreviewSurfaceProvisioner["provision"]>();
    const producer = new PreviewBehaviorGateProducer({
      provisioner: { provision, teardown: vi.fn<PreviewSurfaceProvisioner["teardown"]>() },
      planLoader: planLoaderReturning([fakePlan()]),
      buildExecutor: () => executorWithOutcome("passed"),
    });
    const outcome = await producer.produce({ ...INPUT, behaviorRevisionIds: [] });
    expect(outcome.kind).toBe("not_applicable");
    expect(provision).not.toHaveBeenCalled();
  });

  it("plan load throws (malformed spec) → blocked, no preview deployed", async () => {
    const provision = vi.fn<PreviewSurfaceProvisioner["provision"]>();
    const producer = new PreviewBehaviorGateProducer({
      provisioner: { provision, teardown: vi.fn<PreviewSurfaceProvisioner["teardown"]>() },
      planLoader: planLoaderThrowing(),
      buildExecutor: () => executorWithOutcome("passed"),
    });
    const outcome = await producer.produce(INPUT);
    expect(outcome.kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("no preview surface (non-web product) → not_applicable (merge on CI alone)", async () => {
    const { provisioner } = provisionerReturning({ kind: "no_surface", reason: "no web surface" });
    const producer = new PreviewBehaviorGateProducer({
      provisioner,
      planLoader: planLoaderReturning([fakePlan()]),
      buildExecutor: () => executorWithOutcome("passed"),
    });
    expect((await producer.produce(INPUT)).kind).toBe("not_applicable");
  });

  it("preview deploy FAILED → blocked (fail-closed, no run row)", async () => {
    const { provisioner } = provisionerReturning({ kind: "failed", reason: "deploy error" });
    const producer = new PreviewBehaviorGateProducer({
      provisioner,
      planLoader: planLoaderReturning([fakePlan()]),
      buildExecutor: () => executorWithOutcome("passed"),
    });
    const outcome = await producer.produce(INPUT);
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect("recordedRunId" in outcome && outcome.recordedRunId).toBeFalsy();
  });

  it("every blocking behavior passes on the preview → passed, preview torn down", async () => {
    const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = new PreviewBehaviorGateProducer({
      provisioner,
      planLoader: planLoaderReturning([fakePlan()]),
      buildExecutor: () => executorWithOutcome("passed"),
    });
    expect(await producer.produce(INPUT)).toEqual({ kind: "passed", runId: "vr1", passedBlockingCount: 1 });
    expect(teardown).toHaveBeenCalledOnce();
  });

  it.each<BehaviorVerdictOutcome>(["failed_product", "failed_visual", "failed_verification_contract"])(
    "a decisive product failure (%s) → blocked with recordedRunId, preview torn down",
    async (outcome) => {
      const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
      const producer = new PreviewBehaviorGateProducer({
        provisioner,
        planLoader: planLoaderReturning([fakePlan()]),
        buildExecutor: () => executorWithOutcome(outcome),
      });
      const result = await producer.produce(INPUT);
      expect(result).toMatchObject({ kind: "blocked", recordedRunId: "vr1" });
      expect(teardown).toHaveBeenCalledOnce();
    },
  );

  it.each<BehaviorVerdictOutcome>(["inconclusive_infrastructure", "inconclusive_external", "cancelled_superseded"])(
    "an inconclusive verdict (%s) → blocked (inconclusive ≠ passed)",
    async (outcome) => {
      const { provisioner } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
      const producer = new PreviewBehaviorGateProducer({
        provisioner,
        planLoader: planLoaderReturning([fakePlan()]),
        buildExecutor: () => executorWithOutcome(outcome),
      });
      expect((await producer.produce(INPUT)).kind).toBe("blocked");
    },
  );

  it("the rv-11 run THROWS → blocked, and the preview is STILL torn down (finally)", async () => {
    const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = new PreviewBehaviorGateProducer({
      provisioner,
      planLoader: planLoaderReturning([fakePlan()]),
      buildExecutor: () => ({
        execute: async () => {
          throw new Error("persistence exploded");
        },
      }),
    });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(teardown).toHaveBeenCalledOnce();
  });
});
