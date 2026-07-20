import { describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
} from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { ExecutionMatrix, RequiredSurface } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import type { DesignRenderVerdictRow } from "../src/engine/design/render/designRenderVerdictStore.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";
import {
  AcceptanceOrchestrator,
  recordAttemptedVerdictSequential,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type AcceptanceSurfaceDriver,
  type CompleteAcceptanceRunInput,
  type DesignRenderVerdictReader,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAttemptInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";
import { PreviewBehaviorGateProducer } from "../src/engine/verification/preMerge/preMergeBehaviorGateProducer.js";
import type {
  AcceptanceExecutor,
  BehaviorRevisionResolver,
  PreMergeBehaviorGateInput,
  PreviewProvisionResult,
  PreviewSurface,
  PreviewSurfaceProvisioner,
} from "../src/engine/verification/preMerge/preMergeBehaviorGateProducer.js";
import type { AcceptancePlanLoader } from "../src/engine/verification/acceptance/pgAcceptancePlanLoader.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;

const MATRIX: ExecutionMatrix = {
  browser: [],
  viewport: [],
  locale: [],
  theme: [],
  motion: [],
  contrast: [],
  device: [],
};

class InMemoryAcceptanceRunStore implements AcceptanceRunStore {
  public readonly verdicts: (RecordAcceptanceVerdictInput & { readonly verdictId: string })[] = [];
  private seq = 0;
  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_mem_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    return Promise.resolve();
  }
  public ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    return Promise.resolve(input.planId);
  }
  public recordAttempt(_input: RecordAttemptInput): Promise<string> {
    return Promise.resolve("attempt_mem_1");
  }
  public recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    // The SAME coverage guard the Pg store enforces — the overlay must never forge a pass.
    assertVerdictAssertionCoverage(input);
    const verdictId = `verdict_mem_${(this.seq += 1)}`;
    this.verdicts.push({ ...input, verdictId });
    return Promise.resolve(verdictId);
  }
  public recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    return recordAttemptedVerdictSequential(this, input);
  }
  public listVerdicts(): Promise<readonly StoredAcceptanceVerdict[]> {
    return Promise.resolve([]);
  }
}

class RecordingEventSink implements AcceptanceEventSink {
  public readonly events: { eventType: string; payload: unknown }[] = [];
  public append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ eventType: input.eventType, payload: input.payload });
    return Promise.resolve();
  }
}

function verdictRow(overrides: Partial<DesignRenderVerdictRow>): DesignRenderVerdictRow {
  return {
    outcome: "passed",
    accessibilityStandard: "wcag21aa",
    designContractVersion: "v2",
    releaseId: "rel_1",
    contractDigest: "sha256:abc",
    failingScenarioKey: null,
    failingRuleIds: [],
    checkpointCount: 1,
    checkpoints: [{ checkpointId: "home", verdict: "passed", failingRuleIds: [] }],
    ...overrides,
  };
}

const absentVerdict: DesignRenderVerdictRow | undefined = undefined;

function reader(verdict: DesignRenderVerdictRow | undefined): DesignRenderVerdictReader {
  return { readLatest: () => Promise.resolve(verdict) };
}

function apiDriver(
  observations: readonly DriverObservation[],
  surface: RequiredSurface = "api",
): AcceptanceSurfaceDriver {
  return {
    surface,
    drive(): Promise<DriverExecutionResult | AdapterUnavailableResult> {
      return Promise.resolve({ kind: "executed", observations, providerChecksums: [] });
    },
  };
}

function observation(subject: string, value: DriverObservation["value"]): DriverObservation {
  return { observationKind: "http", subject, value, observedAt: "2026-07-19T00:00:00.000Z" };
}

/** A visual behavior: one passing HTTP assertion PLUS a required rendered-visual requirement. */
function visualPlan(): AcceptancePlan {
  return {
    planId: "plan_visual",
    behaviorRevisionId: "br_visual",
    requiredSurfaces: ["api"],
    assertions: [{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    httpProbes: [{ probeId: "p1", method: "GET", path: "/" }],
    visualVerification: { required: true, accessibilityStandard: "wcag21aa" },
  };
}

function request(plans: readonly AcceptancePlan[]) {
  return {
    orgId: "org_1",
    projectId: "project_1",
    integrationNodeId: "inode_1",
    environmentId: "env_1",
    preparedHeadSha: "abc",
    jjTreeId: "tree",
    artifactDigest: ARTIFACT,
    deploymentFingerprint: "fp",
    plans,
  };
}

describe("AcceptanceOrchestrator — rendered-visual acceptance overlay (rv-13)", () => {
  it("a passing HTTP assertion + a PASSED render verdict yields a passed behavior verdict", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [apiDriver([observation("status", 200)])],
      designRenderReader: reader(verdictRow({ outcome: "passed" })),
    });
    const result = await orchestrator.execute(request([visualPlan()]));
    expect(result.behaviors[0]?.outcome).toBe("passed");
  });

  it("CHANGED COMPONENT → FAILED RENDER: a failed_visual verdict downgrades a passing behavior to failed_visual (BLOCKS)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [apiDriver([observation("status", 200)])],
      designRenderReader: reader(
        verdictRow({ outcome: "failed_visual", failingScenarioKey: "home", failingRuleIds: ["color-contrast"] }),
      ),
    });
    const result = await orchestrator.execute(request([visualPlan()]));
    expect(result.behaviors[0]?.outcome).toBe("failed_visual");
    expect(result.passedVerdictCount).toBe(0);
    // The recorded verdict row carries the fail-closed outcome downstream gates read.
    expect(store.verdicts[0]?.outcome).toBe("failed_visual");
  });

  it("ABSENT render verdict when REQUIRED → inconclusive_infrastructure (BLOCKS)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [apiDriver([observation("status", 200)])],
      designRenderReader: reader(absentVerdict),
    });
    const result = await orchestrator.execute(request([visualPlan()]));
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
  });

  it("NO design-render reader wired but the behavior REQUIRES visual → inconclusive_infrastructure (fail-closed)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [apiDriver([observation("status", 200)])],
    });
    const result = await orchestrator.execute(request([visualPlan()]));
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
  });

  it("a behavior WITHOUT a visual requirement is untouched by the overlay (passes on its assertion alone)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const plan: AcceptancePlan = { ...visualPlan(), planId: "plan_plain" };
    const { visualVerification: _drop, ...plain } = plan;
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [apiDriver([observation("status", 200)])],
      // A reader is present but a plan with no visual requirement never consults it.
      designRenderReader: reader(verdictRow({ outcome: "failed_visual" })),
    });
    const result = await orchestrator.execute(request([plain]));
    expect(result.behaviors[0]?.outcome).toBe("passed");
  });
});

// ── PRODUCTION ENTRY POINT: the pre-merge behavior gate → MergeAuthority land seam ──
// Drives the REAL PreviewBehaviorGateProducer.produce over the REAL AcceptanceOrchestrator
// (with the rv-13 overlay), proving a failed render blocks the merge exactly like a failed
// HTTP behavior. This is the same call graph buildPreMergeBehaviorGateProducer wires in prod.

function previewSurface(): PreviewSurface {
  return {
    deploymentId: "dep_1",
    url: "https://preview.example",
    integrationNodeId: "inode_1",
    artifactDigest: ARTIFACT,
    environmentId: "env_1",
    orgId: "org_1",
    projectId: "project_1",
    provider: "fly",
    appId: "app_1",
  };
}

class FakeProvisioner implements PreviewSurfaceProvisioner {
  public tornDown = false;
  public provision(): Promise<PreviewProvisionResult> {
    return Promise.resolve({ kind: "provisioned", surface: previewSurface() });
  }
  public teardown(): Promise<void> {
    this.tornDown = true;
    return Promise.resolve();
  }
}

const fakeRevisions: BehaviorRevisionResolver = {
  resolveActive: () => Promise.resolve([{ behaviorId: "b_visual", revisionId: "br_visual" }]),
};

function fakePlanLoader(plans: readonly AcceptancePlan[]): AcceptancePlanLoader {
  return { loadPlans: () => Promise.resolve(plans) };
}

function gateInput(): PreMergeBehaviorGateInput {
  return {
    orgId: "org_1",
    projectId: "project_1",
    runId: "run_1",
    specId: "spec_1",
    repoUrl: "https://github.com/x/y",
    headSha: "deadbeef",
    behaviorIds: ["b_visual"],
  };
}

describe("PreviewBehaviorGateProducer — rendered-visual gate feeds the land decision (rv-13)", () => {
  it("BLOCKS the merge when a required behavior's render verdict FAILS on the preview", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const buildExecutor = (baseUrl: string): AcceptanceExecutor => {
      expect(baseUrl).toBe("https://preview.example");
      return new AcceptanceOrchestrator({
        store,
        events: new RecordingEventSink(),
        drivers: [apiDriver([observation("status", 200)])],
        designRenderReader: reader(
          verdictRow({ outcome: "failed_visual", failingScenarioKey: "home", failingRuleIds: ["color-contrast"] }),
        ),
      });
    };
    const provisioner = new FakeProvisioner();
    const producer = new PreviewBehaviorGateProducer({
      provisioner,
      behaviorRevisions: fakeRevisions,
      planLoader: fakePlanLoader([visualPlan()]),
      buildExecutor,
    });
    const outcome = await producer.produce(gateInput());
    expect(outcome.kind).toBe("blocked");
    expect(outcome.kind === "blocked" && outcome.reason).toContain("failed_visual");
    expect(provisioner.tornDown).toBe(true);
    // The blocking verdict was persisted so resolveLandTimeBehaviorGate ALSO blocks at land time.
    expect(store.verdicts[0]?.outcome).toBe("failed_visual");
  });

  it("PASSES the gate when both the HTTP assertion and the render verdict pass", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const buildExecutor = (): AcceptanceExecutor =>
      new AcceptanceOrchestrator({
        store,
        events: new RecordingEventSink(),
        drivers: [apiDriver([observation("status", 200)])],
        designRenderReader: reader(verdictRow({ outcome: "passed" })),
      });
    const producer = new PreviewBehaviorGateProducer({
      provisioner: new FakeProvisioner(),
      behaviorRevisions: fakeRevisions,
      planLoader: fakePlanLoader([visualPlan()]),
      buildExecutor,
    });
    const outcome = await producer.produce(gateInput());
    expect(outcome.kind).toBe("passed");
  });
});
