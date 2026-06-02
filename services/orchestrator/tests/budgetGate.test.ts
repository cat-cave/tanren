// Unit tests for the budget-gate resolution + the pure budget predicates
// (autonomy-engine.md §3 proof 6). `resolveEffectiveBudget` is the project-over-org
// precedence; `isBudgetExhausted` is the gate decision the DagWalker consults.

import { describe, expect, it } from "vitest";
import { isBudgetExhausted } from "../src/engine/contracts/dagWalker.js";
import { resolveEffectiveBudget } from "../src/engine/dag/budgetGate.js";

const orgConfig = (defaultBudget?: { ceilingUsd: number; period?: "monthly" | "total" }) => ({
  version: 1,
  ...(defaultBudget !== undefined && { defaultBudget }),
});
const projectConfig = (budget?: { ceilingUsd: number; period?: "monthly" | "total" }) => ({
  version: 1,
  ...(budget !== undefined && { budget }),
});

describe("resolveEffectiveBudget (project-over-org)", () => {
  it("returns undefined (unlimited) when neither layer sets a budget", () => {
    expect(resolveEffectiveBudget(projectConfig(), orgConfig())).toBeUndefined();
  });

  it("uses the org default when the project sets none", () => {
    const resolved = resolveEffectiveBudget(projectConfig(), orgConfig({ ceilingUsd: 100 }));
    expect(resolved).toEqual({ ceilingUsd: 100, period: "monthly" });
  });

  it("the project budget wins over the org default", () => {
    const resolved = resolveEffectiveBudget(
      projectConfig({ ceilingUsd: 10, period: "total" }),
      orgConfig({ ceilingUsd: 100 }),
    );
    expect(resolved).toEqual({ ceilingUsd: 10, period: "total" });
  });

  it("defaults the period to monthly", () => {
    expect(resolveEffectiveBudget(projectConfig({ ceilingUsd: 5 }), orgConfig())?.period).toBe("monthly");
  });

  it("treats an unparseable config as no budget (never throws)", () => {
    expect(resolveEffectiveBudget({ not: "versioned" }, { also: "bad" })).toBeUndefined();
  });
});

describe("isBudgetExhausted (the gate decision)", () => {
  it("is false when no ceiling is configured (unlimited), regardless of spend", () => {
    expect(isBudgetExhausted({ ceilingUsd: undefined, period: "monthly", spentUsd: 9999 })).toBe(false);
  });

  it("is false when spend is under the ceiling", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "monthly", spentUsd: 49.99 })).toBe(false);
  });

  it("is true when spend reaches the ceiling exactly", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "total", spentUsd: 50 })).toBe(true);
  });

  it("is true when spend exceeds the ceiling", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "monthly", spentUsd: 73.25 })).toBe(true);
  });
});
