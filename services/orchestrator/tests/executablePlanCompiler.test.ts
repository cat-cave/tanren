// rv-2 proof: the executable-plan compiler + typed assertion DSL. A valid behavior
// revision compiles to an ExecutableBehaviorPlanV1 whose assertions are concrete
// typed AssertionExpressions; the compile is deterministic; an unknown operator
// fails closed at the never-guard; an unresolved probe / undeclared cause fails
// closed at parse; a temporal assertion with no authored cursor yields needs_respec
// (never a vacuous plan); and the DSL is exhaustive over the whole operator set.
import { describe, expect, it } from "vitest";
import type {
  BehaviorRevisionId,
  PersonaRevisionId,
  RevisionDigest,
} from "../src/engine/contracts/behaviorRevision.js";
import type { ComparisonOperator } from "../src/engine/contracts/runtimeVerificationPlan.js";
import {
  MalformedAcceptanceSpecError,
  parseAcceptanceSpec,
  type AcceptanceSpecV1,
} from "../src/engine/verification/acceptance/acceptanceSpec.js";
import {
  compileExecutableBehaviorPlan,
  PlanCompileError,
} from "../src/engine/verification/acceptance/executablePlanCompiler.js";

const BEHAVIOR = "br_rv2" as BehaviorRevisionId;
const PERSONA = "persona_revision_rv2" as PersonaRevisionId;
const HASH = `sha256:${"b".repeat(64)}` as RevisionDigest;

function compile(spec: AcceptanceSpecV1) {
  return compileExecutableBehaviorPlan({
    behaviorRevisionId: BEHAVIOR,
    personaRevisionId: PERSONA,
    behaviorRevisionHash: HASH,
    spec,
  });
}

const VALID_ACCEPTANCE = {
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  causes: [{ causeId: "c1", surface: "api", action: "place-order" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
    {
      assertionId: "a3",
      subject: "effects",
      comparisonOperator: "has_cardinality",
      expected: 1,
      correlation: { causeId: "c1", observer: "slack", provider: "slack", requireCorrelationId: true },
    },
    {
      assertionId: "a4",
      subject: "effects",
      comparisonOperator: "not_contains",
      expected: "boom",
      correlation: { causeId: "c1", observer: "slack", provider: "slack", requireCorrelationId: false },
    },
  ],
} as const;

describe("rv-2 compileExecutableBehaviorPlan — valid compile", () => {
  it("compiles a behavior revision into a typed ExecutableBehaviorPlanV1", () => {
    const result = compile(parseAcceptanceSpec(BEHAVIOR, VALID_ACCEPTANCE));
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error("expected compiled");
    const plan = result.plan;
    expect(plan.version).toBe("v1");
    expect(plan.behaviorRevisionId).toBe(BEHAVIOR);
    expect(plan.personaRevisionId).toBe(PERSONA);
    expect(plan.provenance.behaviorRevisionHash).toBe(HASH);
    expect(plan.requiredSurfaces).toEqual(["api"]);
    // Each authored assertion became a CONCRETE typed AssertionExpression kind.
    expect(plan.assertions.map((a) => [a.assertionId, a.kind, a.comparisonOperator])).toEqual([
      ["a1", "scalar_equality", "equals"],
      ["a2", "scalar_order", "greater_than"],
      ["a3", "set_cardinality", "has_cardinality"],
      ["a4", "negative", "not_contains"],
    ]);
    // planId is the plan.v1 domain hash of the whole plan body, and it equals planHash.
    expect(plan.planId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.planHash).toBe(plan.planId);
  });

  it("is deterministic: the same revision + spec yields the same plan hash", () => {
    const a = compile(parseAcceptanceSpec(BEHAVIOR, VALID_ACCEPTANCE));
    const b = compile(parseAcceptanceSpec(BEHAVIOR, VALID_ACCEPTANCE));
    expect(a.kind).toBe("compiled");
    expect(b.kind).toBe("compiled");
    if (a.kind !== "compiled" || b.kind !== "compiled") throw new Error("expected compiled");
    expect(a.planHash).toBe(b.planHash);
  });

  it("resolves a scalar_order direction from the operator (greater_than ⇒ descending)", () => {
    const result = compile(parseAcceptanceSpec(BEHAVIOR, VALID_ACCEPTANCE));
    if (result.kind !== "compiled") throw new Error("expected compiled");
    const order = result.plan.assertions.find((a) => a.assertionId === "a2");
    expect(order?.kind === "scalar_order" ? order.order : undefined).toBe("descending");
  });
});

describe("rv-2 compileExecutableBehaviorPlan — fail closed", () => {
  it("needs_respec: a temporal 'eventually' with no authored cursor is never guessed", () => {
    const result = compile(
      parseAcceptanceSpec(BEHAVIOR, {
        httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
        assertions: [{ assertionId: "t1", subject: "p1.status", comparisonOperator: "eventually", expected: 200 }],
      }),
    );
    expect(result.kind).toBe("needs_respec");
    if (result.kind !== "needs_respec") throw new Error("expected needs_respec");
    expect(result.reasons[0]).toMatch(/eventually/u);
  });

  it("needs_respec: has_cardinality with a non-numeric expected is never coerced to a pass", () => {
    const result = compile(
      parseAcceptanceSpec(BEHAVIOR, {
        httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
        assertions: [{ assertionId: "c", subject: "p1.body", comparisonOperator: "has_cardinality", expected: "many" }],
      }),
    );
    expect(result.kind).toBe("needs_respec");
  });

  it("unknown operator hits the never-guard and throws PlanCompileError (defense in depth)", () => {
    // Bypass the parser's enum to prove the compiler's own exhaustiveness guard is
    // fail-closed, not silently green, if an operator outside the set ever reaches it.
    const spec = {
      requiredSurfaces: ["api"],
      httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
      assertions: [
        {
          assertionId: "x",
          subject: "p1.status",
          comparisonOperator: "totally_bogus" as ComparisonOperator,
          expected: 1,
        },
      ],
      fixtures: [],
      examples: [],
      executionMatrix: {},
      causes: [],
    } as unknown as AcceptanceSpecV1;
    expect(() => compile(spec)).toThrow(PlanCompileError);
  });

  it("unresolved probe reference fails closed at parse", () => {
    expect(() =>
      parseAcceptanceSpec(BEHAVIOR, {
        httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
        assertions: [{ assertionId: "a1", subject: "p2.status", comparisonOperator: "equals", expected: 200 }],
      }),
    ).toThrow(/references no declared http probe/u);
  });

  it("undeclared correlation cause fails closed at parse", () => {
    expect(() =>
      parseAcceptanceSpec(BEHAVIOR, {
        httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
        causes: [{ causeId: "c1", surface: "api", action: "go" }],
        assertions: [
          {
            assertionId: "a1",
            subject: "effects",
            comparisonOperator: "has_cardinality",
            expected: 1,
            correlation: { causeId: "MISSING", observer: "slack", provider: "slack", requireCorrelationId: false },
          },
        ],
      }),
    ).toThrow(MalformedAcceptanceSpecError);
  });
});

describe("rv-2 typed assertion DSL — exhaustive over the whole operator set", () => {
  const ALL_OPERATORS: readonly ComparisonOperator[] = [
    "equals",
    "not_equals",
    "less_than",
    "less_than_or_equal",
    "greater_than",
    "greater_than_or_equal",
    "between",
    "matches_schema",
    "satisfies_predicate",
    "contains",
    "not_contains",
    "has_cardinality",
    "is_unique",
    "exactly_once",
    "eventually",
    "before",
    "after",
    "causes",
    "responds_with",
    "matches",
    "has_no_effect",
  ];
  const NEEDS_RESPEC = new Set<ComparisonOperator>(["eventually", "before", "after"]);

  it("resolves every operator to a concrete AssertionExpression or an explicit needs_respec — never a throw, never vacuous", () => {
    const outcomes = ALL_OPERATORS.map((operator) => {
      const spec = parseAcceptanceSpec(BEHAVIOR, {
        httpProbes: [{ probeId: "p1", method: "GET", path: "/h" }],
        causes: [{ causeId: "c1", surface: "api", action: "go" }],
        assertions: [
          {
            assertionId: "a1",
            subject: "p1.value",
            comparisonOperator: operator,
            expected: 1,
            // `causes` binds a trigger→effect, so it must carry a correlation.
            ...(operator === "causes"
              ? { correlation: { causeId: "c1", observer: "slack", provider: "slack", requireCorrelationId: false } }
              : {}),
          },
        ],
      });
      const result = compile(spec);
      const resolvedOperator = result.kind === "compiled" ? result.plan.assertions[0]?.comparisonOperator : undefined;
      return { operator, kind: result.kind, resolvedOperator };
    });

    const expected = ALL_OPERATORS.map((operator) =>
      NEEDS_RESPEC.has(operator)
        ? { operator, kind: "needs_respec", resolvedOperator: undefined }
        : { operator, kind: "compiled", resolvedOperator: operator },
    );
    expect(outcomes).toEqual(expected);
  });
});
