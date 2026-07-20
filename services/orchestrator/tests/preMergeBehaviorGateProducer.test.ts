// rv-premerge — DB-less unit proof of the pre-merge behavior-gate producer's fail-closed
// decision table + teardown discipline. The producer drives the REAL rv-11 flow through an
// injected executor/provisioner here; the *.rls.integration test proves the real rv-11
// orchestrator + PgAcceptanceRunStore + resolveLandTimeBehaviorGate chain end-to-end.

import { describe, expect, it, vi } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type {
  AcceptancePlan,
  AcceptancePlanLoader,
  AcceptanceRunRequest,
  AcceptanceRunResult,
} from "../src/engine/verification/acceptance/index.js";
import {
  PreviewBehaviorGateProducer,
  type AcceptanceExecutor,
  type BehaviorRevisionResolver,
  type PreMergeBehaviorGateInput,
  type PreviewProvisionResult,
  type PreviewSurface,
  type PreviewSurfaceProvisioner,
  type ResolvedBehaviorRevision,
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
  behaviorIds: ["beh1"],
};

const SURFACE: PreviewSurface = {
  deploymentId: "dep1",
  url: "https://preview.example.test",
  integrationNodeId: "inode_real1",
  artifactDigest: CAS,
  environmentId: "venv1",
  orgId: "org1",
  projectId: "proj1",
  provider: "deploy.vercel",
  appId: "app1",
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
/** Build a resolver from behaviorId→revisionId pairs (the SET the gate checks coverage over). */
function resolverFor(pairs: ReadonlyArray<readonly [string, string]>): BehaviorRevisionResolver {
  const entries: readonly ResolvedBehaviorRevision[] = pairs.map(([behaviorId, revisionId]) => ({
    behaviorId,
    revisionId: revisionId as BehaviorRevisionId,
  }));
  return { resolveActive: async () => entries };
}
function resolverThrowing(): BehaviorRevisionResolver {
  return {
    resolveActive: async () => {
      throw new Error("revision lookup failed");
    },
  };
}

function executorWithOutcome(outcome: BehaviorVerdictOutcome): AcceptanceExecutor {
  return {
    async execute(request: AcceptanceRunRequest): Promise<AcceptanceRunResult> {
      expect(request.purpose).toBe("pre_merge");
      expect(request.externalRunId).toBe("run1");
      expect(request.integrationNodeId).toBe("inode_real1");
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
            evidenceLinkRefs: [],
          },
        ],
      };
    },
  };
}

function provisionerReturning(
  result: PreviewProvisionResult,
  teardown = vi.fn<PreviewSurfaceProvisioner["teardown"]>(async () => {}),
): { provisioner: PreviewSurfaceProvisioner; teardown: ReturnType<typeof vi.fn>; provision: ReturnType<typeof vi.fn> } {
  const provision = vi.fn<PreviewSurfaceProvisioner["provision"]>(async () => result);
  return { teardown, provision, provisioner: { provision, teardown } };
}

/** A fully-working producer over injected deps; overrides let each test vary one collaborator. */
function buildProducer(overrides: {
  provisioner?: PreviewSurfaceProvisioner;
  behaviorRevisions?: BehaviorRevisionResolver;
  planLoader?: AcceptancePlanLoader;
  executor?: AcceptanceExecutor;
}): PreviewBehaviorGateProducer {
  return new PreviewBehaviorGateProducer({
    provisioner: overrides.provisioner ?? provisionerReturning({ kind: "provisioned", surface: SURFACE }).provisioner,
    behaviorRevisions: overrides.behaviorRevisions ?? resolverFor([["beh1", "br1"]]),
    planLoader: overrides.planLoader ?? planLoaderReturning([fakePlan()]),
    buildExecutor: () => overrides.executor ?? executorWithOutcome("passed"),
  });
}

describe("PreviewBehaviorGateProducer — fail-closed decision table", () => {
  it("GENUINELY ZERO declared behaviors → not_applicable (no revision lookup, no preview)", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const resolveActive = vi.fn<BehaviorRevisionResolver["resolveActive"]>(async () => []);
    const producer = buildProducer({ provisioner, behaviorRevisions: { resolveActive } });
    const outcome = await producer.produce({ ...INPUT, behaviorIds: [] });
    expect(outcome.kind).toBe("not_applicable");
    expect(resolveActive).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("declared behaviors resolve to NO active revision → blocked (unverifiable, no preview)", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({ provisioner, behaviorRevisions: resolverFor([]) });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("PARTIAL resolution (2 declared, only 1 active revision) → blocked, never a partial pass", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    // Two declared behaviors, but only ONE resolves to an active revision — the other is
    // unverifiable and must BLOCK, never be silently dropped so the run "passes" on a subset.
    const producer = buildProducer({
      provisioner,
      behaviorRevisions: resolverFor([["beh1", "br1"]]),
      planLoader: planLoaderReturning([fakePlan()]),
    });
    const outcome = await producer.produce({ ...INPUT, behaviorIds: ["beh1", "beh2"] });
    expect(outcome.kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("PARTIAL plan compilation (2 revisions, only 1 plan) → blocked", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({
      provisioner,
      behaviorRevisions: resolverFor([
        ["beh1", "br1"],
        ["beh2", "br2"],
      ]),
      planLoader: planLoaderReturning([fakePlan()]),
    });
    const outcome = await producer.produce({ ...INPUT, behaviorIds: ["beh1", "beh2"] });
    expect(outcome.kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("COUNT hole: behavior A has 2 active revisions, behavior B has 0 → blocked (SET coverage, not count)", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    // A raw/buggy resolver padding beh1 with TWO active revisions while beh2 has none: the OLD
    // count check (2 >= 2 declared) would have PASSED beh2 through silently. SET coverage blocks.
    const producer = buildProducer({
      provisioner,
      behaviorRevisions: resolverFor([
        ["beh1", "br1"],
        ["beh1", "br1b"],
      ]),
    });
    const outcome = await producer.produce({ ...INPUT, behaviorIds: ["beh1", "beh2"] });
    expect(outcome.kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("ALL-PASS: 2 plans but only 1 produced a verdict (a plan unaccounted) → blocked, never ≥1-pass", async () => {
    const { provisioner } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    // Two declared/planned behaviors, but the run yields ONE passing verdict and drops the other
    // (no failure, no inconclusive — just absent). ≥1-passed must NOT pass; every plan is required.
    const oneVerdictExecutor: AcceptanceExecutor = {
      async execute() {
        return {
          runId: "vr1",
          requiredVerdictCount: 2,
          passedVerdictCount: 1,
          runtimeBehaviorContextHash: CAS,
          behaviors: [
            {
              behaviorRevisionId: "br1",
              planId: "plan1",
              verdictId: "vd1",
              outcome: "passed",
              requiredAssertionCount: 1,
              executedAssertionCount: 1,
              passedAssertionCount: 1,
              evidenceLinkRefs: [],
            },
          ],
        };
      },
    };
    const producer = buildProducer({
      provisioner,
      behaviorRevisions: resolverFor([
        ["beh1", "br1"],
        ["beh2", "br2"],
      ]),
      planLoader: planLoaderReturning([fakePlan(), { ...fakePlan(), planId: "plan2", behaviorRevisionId: "br2" }]),
      executor: oneVerdictExecutor,
    });
    const outcome = await producer.produce({ ...INPUT, behaviorIds: ["beh1", "beh2"] });
    expect(outcome).toMatchObject({ kind: "blocked", recordedRunId: "vr1" });
  });

  it("revision resolution THROWS → blocked, no preview deployed", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({ provisioner, behaviorRevisions: resolverThrowing() });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("plan load throws (malformed spec) → blocked, no preview deployed", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({ provisioner, planLoader: planLoaderThrowing() });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("declared behaviors compile to ZERO plans → blocked (unverifiable, no preview)", async () => {
    const { provisioner, provision } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({ provisioner, planLoader: planLoaderReturning([]) });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(provision).not.toHaveBeenCalled();
  });

  it("no preview surface (non-web product) → not_applicable (merge on CI alone)", async () => {
    const { provisioner } = provisionerReturning({ kind: "no_surface", reason: "no web surface" });
    expect((await buildProducer({ provisioner }).produce(INPUT)).kind).toBe("not_applicable");
  });

  it("preview deploy FAILED → blocked (fail-closed, no run row)", async () => {
    const { provisioner } = provisionerReturning({ kind: "failed", reason: "deploy error" });
    const outcome = await buildProducer({ provisioner }).produce(INPUT);
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect("recordedRunId" in outcome && outcome.recordedRunId).toBeFalsy();
  });

  it("every blocking behavior passes on the preview → passed, preview torn down", async () => {
    const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const outcome = await buildProducer({ provisioner, executor: executorWithOutcome("passed") }).produce(INPUT);
    expect(outcome).toEqual({ kind: "passed", runId: "vr1", passedBlockingCount: 1 });
    expect(teardown).toHaveBeenCalledOnce();
  });

  it.each<BehaviorVerdictOutcome>(["failed_product", "failed_visual", "failed_verification_contract"])(
    "a decisive product failure (%s) → blocked with recordedRunId, preview torn down",
    async (outcome) => {
      const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
      const result = await buildProducer({ provisioner, executor: executorWithOutcome(outcome) }).produce(INPUT);
      expect(result).toMatchObject({ kind: "blocked", recordedRunId: "vr1" });
      expect(teardown).toHaveBeenCalledOnce();
    },
  );

  it.each<BehaviorVerdictOutcome>(["inconclusive_infrastructure", "inconclusive_external", "cancelled_superseded"])(
    "an inconclusive verdict (%s) → blocked (inconclusive ≠ passed)",
    async (outcome) => {
      const { provisioner } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
      expect((await buildProducer({ provisioner, executor: executorWithOutcome(outcome) }).produce(INPUT)).kind).toBe(
        "blocked",
      );
    },
  );

  it("the rv-11 run THROWS → blocked, and the preview is STILL torn down (finally)", async () => {
    const { provisioner, teardown } = provisionerReturning({ kind: "provisioned", surface: SURFACE });
    const producer = buildProducer({
      provisioner,
      executor: {
        execute: async () => {
          throw new Error("persistence exploded");
        },
      },
    });
    expect((await producer.produce(INPUT)).kind).toBe("blocked");
    expect(teardown).toHaveBeenCalledOnce();
  });
});
