// Unit tests for the budget-gate resolution + the pure budget predicates
// (autonomy-engine.md §3 proof 6). `resolveEffectiveBudget` is the project-over-org
// precedence; `isBudgetExhausted` is the gate decision the DagWalker consults.

import { describe, expect, it } from "vitest";
import type { BudgetPeriod } from "../src/engine/config/index.js";
import { isBudgetExhausted, type ProjectBudgetState, shouldPauseOnBudget } from "../src/engine/contracts/dagWalker.js";
import { resolveEffectiveBudget } from "../src/engine/dag/budgetGate.js";

// The notional surfacing field the pure predicates ignore — filled here so the
// literals satisfy the ProjectBudgetState type. The gate always gates REAL spend.
const surfacing = { notionalUsd: 0 } satisfies Pick<ProjectBudgetState, "notionalUsd">;

const orgConfig = (defaultBudget?: { ceilingUsd: number; period?: BudgetPeriod }) => ({
  version: 1,
  ...(defaultBudget !== undefined && { defaultBudget }),
});
const projectConfig = (budget?: { ceilingUsd: number; period?: BudgetPeriod }) => ({
  version: 1,
  ...(budget !== undefined && { budget }),
});

describe("resolveEffectiveBudget (project-over-org)", () => {
  it("is an ABSENT (unlimited) budget when neither layer sets one", () => {
    expect(resolveEffectiveBudget(projectConfig(), orgConfig())).toEqual({ kind: "ok", budget: undefined });
  });

  it("uses the org default when the project sets none", () => {
    const resolved = resolveEffectiveBudget(projectConfig(), orgConfig({ ceilingUsd: 100 }));
    // The parsed budget defaults the period to monthly; the gate always sums real spend.
    expect(resolved).toEqual({ kind: "ok", budget: { ceilingUsd: 100, period: "monthly" } });
  });

  it("the project budget wins over the org default", () => {
    const resolved = resolveEffectiveBudget(
      projectConfig({ ceilingUsd: 10, period: "total" }),
      orgConfig({ ceilingUsd: 100 }),
    );
    expect(resolved).toEqual({ kind: "ok", budget: { ceilingUsd: 10, period: "total" } });
  });

  it("defaults the period to monthly", () => {
    const resolved = resolveEffectiveBudget(projectConfig({ ceilingUsd: 5 }), orgConfig());
    expect(resolved).toEqual({ kind: "ok", budget: { ceilingUsd: 5, period: "monthly" } });
  });

  it("accepts the quarterly + annual periods added this PR (no migration)", () => {
    expect(resolveEffectiveBudget(projectConfig({ ceilingUsd: 5, period: "quarterly" }), orgConfig())).toEqual({
      kind: "ok",
      budget: { ceilingUsd: 5, period: "quarterly" },
    });
    expect(resolveEffectiveBudget(projectConfig({ ceilingUsd: 5, period: "annual" }), orgConfig())).toEqual({
      kind: "ok",
      budget: { ceilingUsd: 5, period: "annual" },
    });
  });

  it("BUDGET-SAFETY M5: a PRESENT-but-unparseable config FAILS CLOSED, never unlimited", () => {
    // A present-but-undecodable blob must NOT silently resolve to "no budget".
    expect(resolveEffectiveBudget({ not: "versioned" }, { also: "bad" })).toEqual({ kind: "unparseable" });
    // An unparseable ORG config (after a parseable project with no budget) also fails closed.
    expect(resolveEffectiveBudget(projectConfig(), { also: "bad" })).toEqual({ kind: "unparseable" });
  });
});

describe("shouldPauseOnBudget (the full gate decision, incl. fail-closed)", () => {
  it("pauses on a reached ceiling (the genuine gate)", () => {
    expect(shouldPauseOnBudget({ ceilingUsd: 50, period: "total", spentUsd: 50, ...surfacing })).toBe(true);
  });

  it("does NOT pause under the ceiling with no fail-closed reason", () => {
    expect(shouldPauseOnBudget({ ceilingUsd: 50, period: "monthly", spentUsd: 10, ...surfacing })).toBe(false);
  });

  it("BUDGET-SAFETY C1b: FAILS CLOSED on unpriced spend even when measured spend is $0", () => {
    expect(
      shouldPauseOnBudget({
        ceilingUsd: 50,
        period: "monthly",
        spentUsd: 0,
        ...surfacing,
        failClosed: "unpriced_spend",
      }),
    ).toBe(true);
  });

  it("BUDGET-SAFETY M5: FAILS CLOSED on unparseable config (ceiling undefined)", () => {
    expect(
      shouldPauseOnBudget({
        ceilingUsd: undefined,
        period: "monthly",
        spentUsd: 0,
        ...surfacing,
        failClosed: "unparseable_config",
      }),
    ).toBe(true);
  });
});

describe("isBudgetExhausted (the gate decision)", () => {
  it("is false when no ceiling is configured (unlimited), regardless of spend", () => {
    expect(isBudgetExhausted({ ceilingUsd: undefined, period: "monthly", spentUsd: 9999, ...surfacing })).toBe(false);
  });

  it("is false when spend is under the ceiling", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "monthly", spentUsd: 49.99, ...surfacing })).toBe(false);
  });

  it("is true when spend reaches the ceiling exactly", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "total", spentUsd: 50, ...surfacing })).toBe(true);
  });

  it("is true when spend exceeds the ceiling", () => {
    expect(isBudgetExhausted({ ceilingUsd: 50, period: "monthly", spentUsd: 73.25, ...surfacing })).toBe(true);
  });
});
