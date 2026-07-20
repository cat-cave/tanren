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
  recordAttemptedVerdictSequential,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type AcceptanceSurfaceDriver,
  type CompleteAcceptanceRunInput,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;

// A REAL in-memory store: it enforces the SAME coverage guard the Pg store does
// (a passed verdict with executed < required fails loud) — it never fakes the
// orchestrator's outcome, it only persists what the orchestrator decided.
class InMemoryAcceptanceRunStore implements AcceptanceRunStore {
  public readonly verdicts: (RecordAcceptanceVerdictInput & { readonly verdictId: string })[] = [];
  public readonly plans: EnsureVerificationPlanInput[] = [];
  public readonly attempts: (RecordAttemptInput & { readonly attemptId: string })[] = [];
  public completed = false;
  private seq = 0;

  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_mem_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    this.completed = true;
    return Promise.resolve();
  }
  public ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    this.plans.push(input);
    return Promise.resolve(input.planId);
  }
  public recordAttempt(input: RecordAttemptInput): Promise<string> {
    const attemptId = `attempt_mem_${(this.seq += 1)}`;
    this.attempts.push({ ...input, attemptId });
    return Promise.resolve(attemptId);
  }
  public recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    assertVerdictAssertionCoverage(input);
    // rv-10: mirror the Pg store's fail-closed traceability — a verdict that names a
    // producing attempt only seals if a real attempt with the verdict's key was recorded.
    const backing = this.attempts.filter(
      (a) =>
        a.runId === input.runId &&
        a.behaviorRevisionId === input.behaviorRevisionId &&
        a.exampleHash === input.exampleHash &&
        a.matrixHash === input.matrixHash,
    );
    if (input.attemptTrace.kind === "attempted") {
      const producingAttemptId = input.attemptTrace.producingAttemptId;
      const named = backing.find((a) => a.attemptId === producingAttemptId);
      if (named === undefined) throw new Error(`orphan verdict: producing attempt ${producingAttemptId} not recorded`);
      if (backing.length !== input.attemptCount) {
        throw new Error(`verdict attempt count ${input.attemptCount} != ${backing.length} real attempts`);
      }
    } else if (backing.length > 0) {
      // An attemptless verdict must have NO real backing attempts for its natural key.
      throw new Error(`attemptless verdict has ${backing.length} real attempts for its key`);
    }
    const verdictId = `verdict_mem_${(this.seq += 1)}`;
    this.verdicts.push({ ...input, verdictId });
    return Promise.resolve(verdictId);
  }
  public recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    return recordAttemptedVerdictSequential(this, input);
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

function plan(
  assertions: AcceptancePlan["assertions"],
  surfaces: readonly RequiredSurface[] = ["browser"],
): AcceptancePlan {
  return {
    planId: "plan_1",
    behaviorRevisionId: "br_1",
    requiredSurfaces: surfaces,
    assertions,
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
  };
}

/** A conformance driver: emits REAL observations for the listed subjects only. */
function driver(
  observations: readonly DriverObservation[],
  surface: RequiredSurface = "browser",
): AcceptanceSurfaceDriver {
  return {
    surface,
    drive(): Promise<DriverExecutionResult | AdapterUnavailableResult> {
      return Promise.resolve({ kind: "executed", observations, providerChecksums: [] });
    },
  };
}

function observation(subject: string, value: DriverObservation["value"]): DriverObservation {
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

  it("rv-10 lifecycle: records a plan + real attempt and binds the verdict to that producing attempt", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      now: () => "2026-07-19T00:00:00.000Z",
      drivers: [driver([observation("status", 200)])],
    });
    const result = await orchestrator.execute(
      request([plan([{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }])]),
    );
    // A run → attempt → verdict lifecycle: exactly one plan ensured, one real attempt, one verdict.
    expect(store.plans).toHaveLength(1);
    expect(store.attempts).toHaveLength(1);
    expect(store.verdicts).toHaveLength(1);
    const attempt = store.attempts[0]!;
    const verdict = store.verdicts[0]!;
    // The attempt carries the behavior's resolved outcome + classification and its run key.
    expect(attempt.outcome).toBe("passed");
    expect(attempt.classification).toBe("product_resolved");
    expect(attempt.runId).toBe(verdict.runId);
    expect(attempt.behaviorRevisionId).toBe(verdict.behaviorRevisionId);
    // The verdict is traceable to the attempt that produced it.
    expect(verdict.attemptTrace).toEqual({ kind: "attempted", producingAttemptId: attempt.attemptId });
    expect(result.behaviors[0]?.outcome).toBe("passed");
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

  it("DECISIVE: a wrong-typed observation under not_contains never yields a passed verdict", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      // The observation for `logs` is a NUMBER — type-inapplicable for not_contains.
      drivers: [driver([observation("logs", 42)])],
    });
    const result = await orchestrator.execute(
      request([plan([{ assertionId: "a1", subject: "logs", comparisonOperator: "not_contains", expected: "secret" }])]),
    );
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
    expect(result.passedVerdictCount).toBe(0);
  });

  it("DECISIVE: a wrong-typed observation under has_no_effect never yields a passed verdict", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      // The observation for `effects` is a STRING — not the array has_no_effect needs.
      drivers: [driver([observation("effects", "none")])],
    });
    const result = await orchestrator.execute(
      request([
        plan([{ assertionId: "a1", subject: "effects", comparisonOperator: "has_no_effect", expected: "charge" }]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
  });

  it("a right-typed negative assertion that genuinely holds does pass", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [driver([observation("logs", "clean output")])],
    });
    const result = await orchestrator.execute(
      request([plan([{ assertionId: "a1", subject: "logs", comparisonOperator: "not_contains", expected: "secret" }])]),
    );
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
  });

  it("a multi-surface plan is not passed when a required surface has no driver", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      // Only the browser surface is wired; the required `api` surface is undriven.
      drivers: [driver([observation("status", 200)], "browser")],
    });
    const result = await orchestrator.execute(
      request([
        plan(
          [{ assertionId: "a1", subject: "status", comparisonOperator: "equals", expected: 200 }],
          ["browser", "api"],
        ),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
    expect(result.passedVerdictCount).toBe(0);
  });

  it("a multi-surface plan gathers observations from every driven surface", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [driver([observation("ui_status", 200)], "browser"), driver([observation("api_status", 201)], "api")],
    });
    const result = await orchestrator.execute(
      request([
        plan(
          [
            { assertionId: "a1", subject: "ui_status", comparisonOperator: "equals", expected: 200 },
            { assertionId: "a2", subject: "api_status", comparisonOperator: "equals", expected: 201 },
          ],
          ["browser", "api"],
        ),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(2);
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
        assertionEvidence: [
          { assertionId: "a1", executed: true, passed: true },
          { assertionId: "a2", executed: true, passed: true },
          { assertionId: "a3", executed: false },
          { assertionId: "a4", executed: false },
          { assertionId: "a5", executed: false },
        ],
        attemptEvidence: [{ attemptOrdinal: 1, outcome: "passed" }],
      }),
    ).toThrow(InsufficientAssertionCoverageError);
  });
});
