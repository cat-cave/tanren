// Unit proof for the app-layer twin of migration 0079's behavior_verdicts pass
// gate (#1043 Defect A + #1065 F4 Defect B). No DB: exercises the pure guard.
import { describe, expect, it } from "vitest";
import {
  assertVerdictAssertionCoverage,
  InsufficientAssertionCoverageError,
} from "../src/engine/contracts/runtimeVerification.js";

describe("assertVerdictAssertionCoverage", () => {
  it("rejects a passed verdict that executed fewer than required (Defect A)", () => {
    expect(() =>
      assertVerdictAssertionCoverage({ outcome: "passed", requiredAssertionCount: 12, executedAssertionCount: 1 }),
    ).toThrow(InsufficientAssertionCoverageError);
  });

  it("accepts a passed verdict that executed every required assertion", () => {
    expect(() =>
      assertVerdictAssertionCoverage({ outcome: "passed", requiredAssertionCount: 12, executedAssertionCount: 12 }),
    ).not.toThrow();
  });

  it("rejects a passed verdict with a zero coverage floor (Defect B)", () => {
    expect(() =>
      assertVerdictAssertionCoverage({ outcome: "passed", requiredAssertionCount: 0, executedAssertionCount: 0 }),
    ).toThrow(InsufficientAssertionCoverageError);
  });

  it("does not gate a non-passed verdict on coverage", () => {
    expect(() =>
      assertVerdictAssertionCoverage({
        outcome: "failed_product",
        requiredAssertionCount: 12,
        executedAssertionCount: 0,
      }),
    ).not.toThrow();
  });
});
