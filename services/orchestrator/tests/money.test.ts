// Unit tests for the branded `NonNegativeFinite` money type
// (tanren-owns-the-engine.md §5 P1) — the type that makes an UNLIMITED budget
// UNREPRESENTABLE. These pin that `Infinity` / `NaN` / negative are REJECTED at the
// boundary (a loud throw), never coerced into a passing budget ceiling.

import { describe, expect, it } from "vitest";
import { isNonNegativeFinite, nonNegativeFinite } from "../src/engine/contracts/money.js";

describe("nonNegativeFinite — the forbidden-unlimited constructor", () => {
  it("accepts finite non-negative numbers (incl. 0)", () => {
    expect(nonNegativeFinite(0)).toBe(0);
    expect(nonNegativeFinite(49.99)).toBe(49.99);
  });

  it("REJECTS Infinity (the effective-unlimited budget hole)", () => {
    expect(() => nonNegativeFinite(Number.POSITIVE_INFINITY)).toThrow(/finite|unlimited|forbidden/iu);
  });

  it("REJECTS NaN", () => {
    expect(() => nonNegativeFinite(Number.NaN)).toThrow(/finite|unlimited|forbidden/iu);
  });

  it("REJECTS negative amounts", () => {
    expect(() => nonNegativeFinite(-1)).toThrow(/finite|unlimited|forbidden/iu);
  });
});

describe("isNonNegativeFinite — the no-throw predicate", () => {
  it("is true only for finite non-negative numbers", () => {
    expect(isNonNegativeFinite(10)).toBe(true);
    expect(isNonNegativeFinite(0)).toBe(true);
    expect(isNonNegativeFinite(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonNegativeFinite(Number.NaN)).toBe(false);
    expect(isNonNegativeFinite(-0.01)).toBe(false);
  });
});
