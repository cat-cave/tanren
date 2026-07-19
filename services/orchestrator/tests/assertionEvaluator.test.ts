import { describe, expect, it } from "vitest";
import type { CanonicalBody } from "../src/engine/contracts/cas.js";
import type { ComparisonOperator } from "../src/engine/contracts/runtimeVerificationPlan.js";
import { evaluateAssertion } from "../src/engine/verification/acceptance/assertionEvaluator.js";

// Every operator is exercised with an applicable-type PASS, an applicable-type
// FAIL, and — the decisive false-green guard — a TYPE-INAPPLICABLE actual that
// must NOT satisfy. A wrong-typed observation may never be laundered into a pass,
// especially through the negative operators.
type Case = {
  readonly operator: ComparisonOperator;
  readonly pass: readonly [CanonicalBody, CanonicalBody];
  readonly fail: readonly [CanonicalBody, CanonicalBody];
  readonly inapplicable: readonly [CanonicalBody, CanonicalBody];
};

const CASES: readonly Case[] = [
  { operator: "equals", pass: [5, 5], fail: [5, 6], inapplicable: ["5", 5] },
  { operator: "not_equals", pass: [5, 6], fail: [5, 5], inapplicable: [{ a: 1 }, { a: 1 }] },
  { operator: "less_than", pass: [1, 2], fail: [2, 1], inapplicable: ["a", 2] },
  { operator: "less_than_or_equal", pass: [2, 2], fail: [3, 2], inapplicable: [null, 2] },
  { operator: "greater_than", pass: [3, 2], fail: [1, 2], inapplicable: ["a", 2] },
  { operator: "greater_than_or_equal", pass: [2, 2], fail: [1, 2], inapplicable: [true, 2] },
  { operator: "contains", pass: ["hello", "ell"], fail: ["hello", "z"], inapplicable: [5, "e"] },
  { operator: "not_contains", pass: ["hello", "z"], fail: ["hello", "ell"], inapplicable: [5, "z"] },
  { operator: "matches", pass: ["abc123", "[0-9]+"], fail: ["abc", "[0-9]+"], inapplicable: [123, "[0-9]+"] },
  { operator: "has_cardinality", pass: [[1, 2], 2], fail: [[1], 2], inapplicable: ["ab", 2] },
  { operator: "is_unique", pass: [[1, 2, 3], null], fail: [[1, 1], null], inapplicable: ["abc", null] },
  { operator: "exactly_once", pass: [["a", "b"], "a"], fail: [["a", "a"], "a"], inapplicable: ["a", "a"] },
  { operator: "has_no_effect", pass: [["a", "b"], "c"], fail: [["a", "c"], "c"], inapplicable: [5, "c"] },
  { operator: "causes", pass: ["x", "x"], fail: ["x", "y"], inapplicable: [1, "1"] },
  { operator: "responds_with", pass: [200, 200], fail: [500, 200], inapplicable: ["200", 200] },
  { operator: "between", pass: [5, 5], fail: [5, 6], inapplicable: [{ x: 1 }, 5] },
  {
    operator: "matches_schema",
    pass: [{ ok: true }, { ok: true }],
    fail: [{ ok: true }, { ok: false }],
    inapplicable: [1, {}],
  },
  { operator: "satisfies_predicate", pass: ["p", "p"], fail: ["p", "q"], inapplicable: [1, "p"] },
  { operator: "eventually", pass: ["e", "e"], fail: ["e", "f"], inapplicable: [1, "e"] },
  { operator: "before", pass: ["t", "t"], fail: ["t", "u"], inapplicable: [1, "t"] },
  { operator: "after", pass: ["t", "t"], fail: ["t", "u"], inapplicable: [1, "t"] },
];

describe.each(CASES)("evaluateAssertion — operator $operator, fail-closed on type", (testCase) => {
  it("satisfies an applicable-type match", () => {
    expect(evaluateAssertion(testCase.operator, testCase.pass[0], testCase.pass[1])).toBe(true);
  });
  it("rejects an applicable-type mismatch", () => {
    expect(evaluateAssertion(testCase.operator, testCase.fail[0], testCase.fail[1])).toBe(false);
  });
  it("does NOT satisfy a type-inapplicable actual (no false-green)", () => {
    expect(evaluateAssertion(testCase.operator, testCase.inapplicable[0], testCase.inapplicable[1])).toBe(false);
  });
});

describe("evaluateAssertion — negative operators are fail-closed on type", () => {
  it("DECISIVE: not_contains on a wrong-typed (numeric) actual is never satisfied", () => {
    expect(evaluateAssertion("not_contains", 42, "danger")).toBe(false);
    expect(evaluateAssertion("not_contains", null, "danger")).toBe(false);
    expect(evaluateAssertion("not_contains", true, "danger")).toBe(false);
  });

  it("DECISIVE: has_no_effect on a wrong-typed (non-array) actual is never satisfied", () => {
    expect(evaluateAssertion("has_no_effect", 0, "effect")).toBe(false);
    expect(evaluateAssertion("has_no_effect", "no effect here", "effect")).toBe(false);
    expect(evaluateAssertion("has_no_effect", null, "effect")).toBe(false);
  });

  it("not_contains passes only when a right-typed actual genuinely lacks the value", () => {
    expect(evaluateAssertion("not_contains", "clean output", "danger")).toBe(true);
    expect(evaluateAssertion("not_contains", ["a", "b"], "danger")).toBe(true);
    expect(evaluateAssertion("not_contains", "danger zone", "danger")).toBe(false);
  });

  it("has_no_effect passes only when a real array genuinely lacks the occurrence", () => {
    expect(evaluateAssertion("has_no_effect", ["a", "b"], "effect")).toBe(true);
    expect(evaluateAssertion("has_no_effect", [], "effect")).toBe(true);
    expect(evaluateAssertion("has_no_effect", ["effect"], "effect")).toBe(false);
  });
});
