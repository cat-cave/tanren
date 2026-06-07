// A branded `NonNegativeFinite` USD amount (tanren-owns-the-engine.md §0, §5) —
// the type that makes an UNLIMITED budget UNREPRESENTABLE.
//
// WHY (the audit it closes): §5 P1. The budget gate must NEVER fail open to an
// effectively-unlimited ceiling. A bare `number` permits `Infinity` / `NaN` /
// negative, and a `spent >= ceiling` check then treats `Infinity` as "never
// exhausted" — a silent unlimited budget. By constraining the budget ceiling +
// spend to this BRAND (constructed only through `nonNegativeFinite`, which THROWS
// on Infinity/NaN/negative), the forbidden value cannot be put into a
// `BudgetScope.resolved` at all. The constraint is enforced at the boundary, once,
// loudly — never silently degraded to a default.

/**
 * A USD amount proven finite + non-negative. The brand is unforgeable: the only
 * way to obtain one is `nonNegativeFinite`, which rejects Infinity/NaN/negative.
 * So a budget ceiling/spend typed as `NonNegativeFinite` CANNOT carry an unlimited
 * value — the fail-open budget hole is closed structurally, not by a runtime check
 * scattered across callers.
 */
export type NonNegativeFinite = number & { readonly __brand: "NonNegativeFinite" };

/**
 * Construct a {@link NonNegativeFinite}, THROWING (loud, never silent) on a value
 * that is not a finite, non-negative number. This is the SOLE constructor — a
 * budget ceiling can only enter the engine through it, so Infinity/NaN/negative is
 * rejected at the boundary, never treated as a pass.
 */
export function nonNegativeFinite(value: number): NonNegativeFinite {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`not a finite non-negative amount: ${String(value)} (an unlimited/invalid budget is forbidden)`);
  }
  return value as NonNegativeFinite;
}

/** Whether `value` is a finite, non-negative number (the predicate form, no throw). */
export function isNonNegativeFinite(value: number): value is NonNegativeFinite {
  return Number.isFinite(value) && value >= 0;
}
