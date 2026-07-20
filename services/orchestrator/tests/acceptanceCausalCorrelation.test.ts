import { describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";
import type { AdapterUnavailableResult } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { EffectObservation } from "../src/engine/contracts/sideEffectObserverAdapter.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  recordAttemptedVerdictSequential,
  type AcceptanceCauseDriver,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type CausalEffectReader,
  type CauseDriveInput,
  type CauseFiring,
  type CompleteAcceptanceRunInput,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAttemptInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;
const ID = (n: number): string => `sha256:${String(n).padStart(64, "0")}`;

// The SAME real coverage guard the Pg store enforces — never fakes an outcome.
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

class NullEventSink implements AcceptanceEventSink {
  public append<N extends EventName>(_input: AppendEventInput<N>): Promise<void> {
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

// A REAL cause driver: it fires the cause and reports a genuine firing. A fake
// that fabricates a correlated effect is forbidden — this only reports the id it
// propagated + the cursor it fired at; correlation is computed by the engine.
function causeDriver(firing: CauseFiring | AdapterUnavailableResult): AcceptanceCauseDriver {
  return {
    surface: "api",
    fireCause(_input: CauseDriveInput): Promise<CauseFiring | AdapterUnavailableResult> {
      return Promise.resolve(firing);
    },
  };
}

// A conformance-fake reader over the rv-8 observation shape. It returns the
// recorded evidence verbatim; it does NOT decide correlation.
function reader(effects: readonly EffectObservation[]): CausalEffectReader {
  return {
    effectsForProvider(): Promise<readonly EffectObservation[]> {
      return Promise.resolve(effects);
    },
  };
}

function throwingReader(): CausalEffectReader {
  return {
    effectsForProvider(): Promise<readonly EffectObservation[]> {
      return Promise.reject(new Error("slack API unreachable"));
    },
  };
}

function effect(overrides: Partial<EffectObservation>): EffectObservation {
  return {
    orgId: "org_1",
    projectId: "project_1",
    observationId: overrides.observationId ?? `obs_${Math.random()}`,
    observer: "slack",
    provider: "slack",
    occurrenceCount: 1,
    classification: "ok",
    createdAt: new Date("2026-07-18T00:00:00.000Z"),
    ...overrides,
  };
}

function causalPlan(
  operator: AcceptancePlan["assertions"][number]["comparisonOperator"],
  expected: AcceptancePlan["assertions"][number]["expected"],
  requireCorrelationId = true,
): AcceptancePlan {
  return {
    planId: "plan_causal",
    behaviorRevisionId: "br_causal",
    requiredSurfaces: [],
    assertions: [
      {
        assertionId: "a1",
        subject: "slack_effects",
        comparisonOperator: operator,
        expected,
        correlation: { causeId: "order", observer: "slack", provider: "slack", requireCorrelationId },
      },
    ],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    causes: [{ causeId: "order", surface: "api", action: "post_order" }],
  };
}

function request(plan: AcceptancePlan) {
  return {
    orgId: "org_1",
    projectId: "project_1",
    integrationNodeId: "inode_1",
    environmentId: "env_1",
    preparedHeadSha: "abc",
    jjTreeId: "tree",
    artifactDigest: ARTIFACT,
    deploymentFingerprint: "fp",
    plans: [plan],
  };
}

const FIRING: CauseFiring = { causeId: "order", correlationId: ID(1), firedAtCursor: "1000" };
// A REAL firing that propagated NO correlation id (the cause offers no id).
const FIRING_NO_ID: CauseFiring = { causeId: "order", firedAtCursor: "1000" };

// Two DISTINCT causes fired at the SAME cursor, sharing one observer+provider —
// each assertion counts the effects of its own cause by WINDOW alone.
function twoSiblingSameCursorPlan(): AcceptancePlan {
  return {
    planId: "plan_siblings",
    behaviorRevisionId: "br_siblings",
    requiredSurfaces: [],
    assertions: [
      {
        assertionId: "a1",
        subject: "eff_c1",
        comparisonOperator: "has_cardinality",
        expected: 1,
        correlation: { causeId: "c1", observer: "slack", provider: "slack", requireCorrelationId: false },
      },
      {
        assertionId: "a2",
        subject: "eff_c2",
        comparisonOperator: "has_cardinality",
        expected: 1,
        correlation: { causeId: "c2", observer: "slack", provider: "slack", requireCorrelationId: false },
      },
    ],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    causes: [
      { causeId: "c1", surface: "api", action: "fire_c1" },
      { causeId: "c2", surface: "api", action: "fire_c2" },
    ],
  };
}

describe("rv-12 A3 causal-correlation orchestration", () => {
  it("exactly one correlated effect passes the has_cardinality(1) assertion", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
    expect(result.passedVerdictCount).toBe(1);
  });

  it("DECISIVE: an effect from a DIFFERENT cause is not counted toward this cardinality", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // Two in-window effects, but only ID(1) carries this cause's correlation id.
      effectReader: reader([
        effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) }),
        effect({ cursor: "1500", triggerIdHash: ID(2), providerObjectHash: ID(8) }),
      ]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    // Still exactly one CORRELATED effect ⇒ passes; the other cause's effect is excluded.
    expect(result.behaviors[0]?.outcome).toBe("passed");
  });

  it("DECISIVE: zero real correlated effects under exactly-one is failed_product, never passed", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // Only a different-cause effect exists ⇒ zero correlated to THIS cause.
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(2), providerObjectHash: ID(8) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
    expect(result.passedVerdictCount).toBe(0);
  });

  it("DECISIVE: a pre-existing effect (before the cause fired) is not counted", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // cursor 500 < firedAt 1000 ⇒ pre-existing ⇒ excluded ⇒ zero correlated.
      effectReader: reader([effect({ cursor: "500", triggerIdHash: ID(1), providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
  });

  it("FAIL-CLOSED: a missing effect reader yields inconclusive_infrastructure, never passed", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // no effectReader wired
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(0);
    expect(result.passedVerdictCount).toBe(0);
  });

  it("FAIL-CLOSED: an inconclusive observer is NOT laundered into has_no_effect passing", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // The reader raises ⇒ inconclusive; a has_no_effect assertion must NOT pass
      // just because the (unobservable) correlated set looks empty.
      effectReader: throwingReader(),
    });
    const result = await orchestrator.execute(request(causalPlan("has_no_effect", ID(9))));
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(0);
  });

  it("a genuine observed-zero DOES pass has_no_effect (distinct from inconclusive)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // Observer available, genuinely zero correlated effects.
      effectReader: reader([]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_no_effect", ID(9))));
    expect(result.behaviors[0]?.outcome).toBe("passed");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(1);
  });

  it("FAIL-CLOSED: a missing cause driver yields inconclusive_infrastructure", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      // no causeDrivers wired
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
    expect(result.passedVerdictCount).toBe(0);
  });

  it("FAIL-CLOSED: a cause driver reporting unavailable propagates its outcome", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver({ kind: "unavailable", outcome: "inconclusive_external", reason: "api down" })],
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 1)));
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_external");
    expect(result.passedVerdictCount).toBe(0);
  });

  it("is_unique detects a duplicated correlated delivery (failed_product)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      // Two correlated effects sharing the SAME provider object hash ⇒ not unique.
      effectReader: reader([
        effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) }),
        effect({ cursor: "1600", triggerIdHash: ID(1), providerObjectHash: ID(9) }),
      ]),
    });
    const result = await orchestrator.execute(request(causalPlan("is_unique", null)));
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
  });

  it("FALSE-GREEN BLOCKED (Finding 1): requireCorrelationId=true + a cause with NO id must NOT pass a negative operator", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      // The cause propagated no correlation id, yet the assertion REQUIRES id
      // correlation — the correlated set is empty purely for lack of an id, never
      // from a genuine observation. A has_no_effect assertion must NOT pass on
      // that empty set. Before the fix the stage still emitted an empty-set
      // observation, EXECUTING the assertion so the negative operator passed
      // trivially (a latent false-green feeding the sole merge authority).
      causeDrivers: [causeDriver(FIRING_NO_ID)],
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_no_effect", ID(9), true)));
    // The assertion did NOT execute (no observation) ⇒ drops to the established
    // most-restrictive disposition for a required-but-unobservable assertion.
    expect(result.behaviors[0]?.outcome).not.toBe("passed");
    expect(result.behaviors[0]?.outcome).toBe("failed_verification_contract");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(0);
    expect(result.passedVerdictCount).toBe(0);
  });

  it("FALSE-GREEN BLOCKED (Finding 1): the same holds for has_cardinality(0)", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING_NO_ID)],
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("has_cardinality", 0, true)));
    expect(result.behaviors[0]?.outcome).toBe("failed_verification_contract");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(0);
  });

  it("NO-LEAK (Finding 2): two causes at the SAME cursor do not each claim the same effect", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      // Both causes fire at cursor "1000" (the api driver serves both); one effect
      // at "1500" follows. Before the fix the same-cursor sibling was erased by
      // VALUE, each window ran to infinity, and the effect leaked into BOTH causes
      // (has_cardinality(1) passed twice). After the fix the sibling bounds the
      // window to empty, so NEITHER cause claims the ambiguous effect.
      causeDrivers: [causeDriver(FIRING_NO_ID)],
      effectReader: reader([effect({ cursor: "1500", providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(twoSiblingSameCursorPlan()));
    // Both assertions executed (observations emitted) but the count is 0, so the
    // has_cardinality(1) assertions fail — the effect leaked into NEITHER.
    expect(result.behaviors[0]?.outcome).toBe("failed_product");
    expect(result.behaviors[0]?.executedAssertionCount).toBe(2);
    expect(result.behaviors[0]?.passedAssertionCount).toBe(0);
    expect(result.passedVerdictCount).toBe(0);
  });

  it("at-most cardinality via less_than_or_equal on the correlated count passes", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NullEventSink(),
      causeDrivers: [causeDriver(FIRING)],
      effectReader: reader([effect({ cursor: "1500", triggerIdHash: ID(1), providerObjectHash: ID(9) })]),
    });
    const result = await orchestrator.execute(request(causalPlan("less_than_or_equal", 2)));
    expect(result.behaviors[0]?.outcome).toBe("passed");
  });
});
