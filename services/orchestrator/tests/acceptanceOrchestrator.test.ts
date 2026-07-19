import { describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { InsufficientAssertionCoverageError } from "../src/engine/contracts/runtimeVerificationInvariants.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
} from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { ExecutionMatrix, RequiredSurface } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type AcceptanceSurfaceDriver,
  type CompleteAcceptanceRunInput,
  type RecordAcceptanceRunInput,
  type RecordAcceptanceVerdictInput,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;

// A REAL in-memory store: it enforces the SAME coverage guard the Pg store does
// (a passed verdict with executed < required fails loud) — it never fakes the
// orchestrator's outcome, it only persists what the orchestrator decided.
class InMemoryAcceptanceRunStore implements AcceptanceRunStore {
  public readonly verdicts: (RecordAcceptanceVerdictInput & { readonly verdictId: string })[] = [];
  public completed = false;
  private seq = 0;

  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_mem_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    this.completed = true;
    return Promise.resolve();
  }
  public recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    assertVerdictAssertionCoverage(input);
    const verdictId = `verdict_mem_${(this.seq += 1)}`;
    this.verdicts.push({ ...input, verdictId });
    return Promise.resolve(verdictId);
  }
  public listVerdicts(): Promise<readonly StoredAcceptanceVerdict[]> {
    return Promise.resolve(
      this.verdicts.map((v) => ({
        verdictId: v.verdictId,
        behaviorRevisionId: v.behaviorRevisionId,
        outcome: v.outcome,
        requiredAssertionCount: v.requiredAssertionCount,
        executedAssertionCount: v.executedAssertionCount,
        flakeState: v.flakeState,
      })),
    );
  }
}

class RecordingEventSink implements AcceptanceEventSink {
  public readonly events: { eventType: string; payload: unknown }[] = [];
  public append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ eventType: input.eventType, payload: input.payload });
    return Promise.resolve();
  }
}

const MATRIX: ExecutionMatrix = {
  browser: ["chromium"],
  viewport: ["1280x720"],
  locale: ["en"],
  theme: ["light"],
  motion: ["no-preference"],
  contrast: ["normal"],
  device: ["desktop"],
};

function plan(assertions: AcceptancePlan["assertions"], surface: RequiredSurface = "browser"): AcceptancePlan {
  return {
    planId: "plan_1",
    behaviorRevisionId: "br_1",
    requiredSurfaces: [surface],
    assertions,
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
  };
}

/** A conformance driver: emits REAL observations for the listed subjects only. */
function driver(observations: readonly DriverObservation[]): AcceptanceSurfaceDriver {
  return {
    surface: "browser",
    drive(): Promise<DriverExecutionResult | AdapterUnavailableResult> {
      return Promise.resolve({ kind: "executed", observations, providerChecksums: [] });
    },
  };
}

function observation(subject: string, value: number): DriverObservation {
  return { observationKind: "http", subject, value, observedAt: "2026-07-18T00:00:00.000Z" };
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

describe("AcceptanceOrchestrator — executable acceptance A1", () => {
  it("records a passed verdict only when every required assertion executed and passed", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const events = new RecordingEventSink();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events,
      drivers: [driver([observation("status", 200), observation("count", 3)])],
    });
    const result = await orchestrator.execute(
      request([
        plan([
          { assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 },
          { assertionId: "a2", subject: "count", comparisonOperator: "greater_than", expected: 1 },
        ]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(2);
    expect(result.behaviors[0]?.requiredAssertionCount).toBe(2);
    expect(result.passedVerdictCount).toBe(1);
    expect(store.completed).toBe(true);
    const verdictEvent = events.events.find((e) => e.eventType === "behavior.verdict.recorded");
    expect(verdictEvent).toBeDefined();
    const verdictPayload = verdictEvent?.payload as { outcome: string; executedAssertionCount: number };
    expect(verdictPayload.outcome).toBe("passed");
    expect(verdictPayload.executedAssertionCount).toBe(2);
  });

  it("DECISIVE false-green: fewer assertions executed than required is never passed", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      // The driver observes ONLY `status` — the `count` assertion never executes.
      drivers: [driver([observation("status", 200)])],
    });
    const result = await orchestrator.execute(
      request([
        plan([
          { assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 },
          { assertionId: "a2", subject: "count", comparisonOperator: "greater_than", expected: 1 },
        ]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("failed_verification_contract");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
    expect(result.behaviors[0]?.requiredAssertionCount).toBe(2);
    expect(result.passedVerdictCount).toBe(0);
  });

  it("a failed assertion (observed but unsatisfied) yields failed_product, never passed", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [driver([observation("status", 500)])],
    });
    const result = await orchestrator.execute(
      request([plan([{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }])]),
    );
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
  });

  it("no driver for the required surface fails closed to inconclusive_infrastructure", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({ store, events: new RecordingEventSink() });
    const result = await orchestrator.execute(
      request([plan([{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }])]),
    );
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(0);
  });

  it("a plan with zero assertions can never be a pass (coverage floor)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({ store, events: new RecordingEventSink(), drivers: [driver([])] });
    const result = await orchestrator.execute(request([plan([])]));
    expect(result.behaviors[0]?.outcome).toBe("failed_verification_contract");
  });

  it("recordVerdict's coverage guard rejects a passed verdict with under-coverage", () => {
    const store = new InMemoryAcceptanceRunStore();
    expect(() =>
      store.recordVerdict({
        orgId: "org_1",
        projectId: "project_1",
        runId: "run_mem_1",
        behaviorRevisionId: "br_1",
        exampleHash: "h",
        matrixHash: "h",
        requiredAssertionCount: 5,
        executedAssertionCount: 2,
        outcome: "passed",
        attemptCount: 1,
        flakeState: "stable",
        gateEffect: "blocking",
        artifactDigest: ARTIFACT,
        runtimeBehaviorContextHash: ARTIFACT,
      }),
    ).toThrow(InsufficientAssertionCoverageError);
  });
});
