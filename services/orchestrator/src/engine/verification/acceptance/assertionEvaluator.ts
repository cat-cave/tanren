/**
 * rv-11 A1 acceptance: the deterministic per-assertion evaluator. Given the typed
 * comparison operator, the ACTUAL value a driver observed for the assertion's
 * subject, and the plan's EXPECTED value, it decides whether the assertion is
 * satisfied. It never decides whether an assertion *executed* — that is the
 * orchestrator's job (an assertion executes only when a driver observation exists
 * for its subject), so a missing observation can never be laundered into a pass.
 */

import { canonicalJson, type CanonicalBody } from "../../contracts/cas.js";
import type { ComparisonOperator } from "../../contracts/runtimeVerificationPlan.js";

function deepEqual(a: CanonicalBody, b: CanonicalBody): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function asNumber(value: CanonicalBody): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compareNumeric(
  actual: CanonicalBody,
  expected: CanonicalBody,
  satisfied: (a: number, e: number) => boolean,
): boolean {
  const a = asNumber(actual);
  const e = asNumber(expected);
  if (a === undefined || e === undefined) return false;
  return satisfied(a, e);
}

function containsValue(actual: CanonicalBody, expected: CanonicalBody): boolean {
  if (typeof actual === "string") {
    return typeof expected === "string" && actual.includes(expected);
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => deepEqual(item, expected));
  }
  return false;
}

function matchesRegex(actual: CanonicalBody, expected: CanonicalBody): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  try {
    return new RegExp(expected, "u").test(actual);
  } catch {
    return false;
  }
}

function hasCardinality(actual: CanonicalBody, expected: CanonicalBody): boolean {
  const e = asNumber(expected);
  return Array.isArray(actual) && e !== undefined && actual.length === e;
}

function isUnique(actual: CanonicalBody): boolean {
  if (!Array.isArray(actual)) return false;
  const seen = new Set<string>();
  for (const item of actual) {
    const key = canonicalJson(item);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function occurrenceCount(actual: CanonicalBody, expected: CanonicalBody): number {
  if (!Array.isArray(actual)) return 0;
  return actual.filter((item) => deepEqual(item, expected)).length;
}

/**
 * Evaluate one assertion's observed value against its expectation. This is only
 * called for assertions that genuinely executed (a driver observation exists);
 * the caller counts executions independently.
 */
export function evaluateAssertion(
  operator: ComparisonOperator,
  actual: CanonicalBody,
  expected: CanonicalBody,
): boolean {
  switch (operator) {
    case "equals":
    case "responds_with":
    case "causes":
      return deepEqual(actual, expected);
    case "not_equals":
      return !deepEqual(actual, expected);
    case "less_than":
      return compareNumeric(actual, expected, (a, e) => a < e);
    case "less_than_or_equal":
      return compareNumeric(actual, expected, (a, e) => a <= e);
    case "greater_than":
      return compareNumeric(actual, expected, (a, e) => a > e);
    case "greater_than_or_equal":
      return compareNumeric(actual, expected, (a, e) => a >= e);
    case "contains":
      return containsValue(actual, expected);
    case "not_contains":
      return !containsValue(actual, expected);
    case "matches":
      return matchesRegex(actual, expected);
    case "has_cardinality":
      return hasCardinality(actual, expected);
    case "is_unique":
      return isUnique(actual);
    case "exactly_once":
      return occurrenceCount(actual, expected) === 1;
    case "has_no_effect":
      return occurrenceCount(actual, expected) === 0;
    default:
      // between / matches_schema / satisfies_predicate / eventually / before /
      // after — no richer evaluator here yet, so require canonical equality
      // rather than silently passing. Fail-closed: unknown never green by luck.
      return deepEqual(actual, expected);
  }
}
