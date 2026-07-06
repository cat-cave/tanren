// Unit tests for the budget-gate resolution + the pure budget predicates
// (autonomy-engine.md §3 proof 6). `resolveEffectiveBudget` is the project-over-org
// precedence; `isBudgetExhausted` is the gate decision the DagWalker consults;
// `PgBudgetGate.resolveBudget` is the production seam the walker gates on — pinned
// here against the in-memory RoutesPool so the fail-CLOSED unresolvable-project
// branch (Codex critic #11) runs in the fast-check gate too, not only under the
// TANREN_RLS_DB_TEST integration slice.

import { describe, expect, it } from "vitest";
import type { BudgetPeriod } from "../src/engine/config/index.js";
import { isBudgetExhausted, type ProjectBudgetState, shouldPauseOnBudget } from "../src/engine/contracts/dagWalker.js";
import { PgBudgetGate, resolveEffectiveBudget } from "../src/engine/dag/budgetGate.js";
import { RoutesPool } from "./helpers/routesPool.js";

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

  it("BUDGET-SAFETY Codex #11: FAILS CLOSED on unresolvable project org (never silent-unlimited)", () => {
    // "The budget is the only run gate" — an unreadable project row / null org_id
    // must NOT silently degrade to unlimited. The gate reports failClosed with a
    // typed reason; the walker pauses on this the same way as an exhausted ceiling.
    expect(
      shouldPauseOnBudget({
        ceilingUsd: undefined,
        period: "monthly",
        spentUsd: 0,
        ...surfacing,
        failClosed: "unresolvable_project_org",
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

// The production `PgBudgetGate.resolveBudget` seam — driven against the in-memory
// RoutesPool (the SQL surface the pg gate reads is covered by the pool helper). The
// live RLS-scoped smoke path is `pgBudgetGate.integration.test.ts`; this file pins
// the safety branches so the fast-check gate catches regressions of the fail-CLOSED
// invariant (Codex critic #11): a MISSING project row or a NULL `org_id` must NOT
// silently resolve as UNLIMITED (which would let spend run past the operator's
// intended ceiling). Both branches must return `failClosed: "unresolvable_project_org"`.
describe("PgBudgetGate.resolveBudget (fail-closed safety branches)", () => {
  it("FAILS CLOSED on a missing project row — never silent-unlimited (Codex critic #11)", async () => {
    const pool = new RoutesPool();
    // No project seeded — the `SELECT org_id, config FROM projects WHERE project_id = $1`
    // read returns zero rows, the same signal an ownership-corruption or race would carry.
    const gate = new PgBudgetGate(pool.asPgPool());

    const state = await gate.resolveBudget("proj_never_seeded");

    // The gate must NOT report the missing row as unlimited — that would let an
    // ordinary budget-enforcement read failure bypass the ceiling entirely.
    expect(state.failClosed).toBe("unresolvable_project_org");
    expect(state.ceilingUsd).toBeUndefined();
    expect(state.spentUsd).toBe(0);
    // The walker's public predicate must agree — this is a pause, not a green light.
    expect(shouldPauseOnBudget(state)).toBe(true);
  });

  it("FAILS CLOSED on a project row whose org_id is NULL — never silent-unlimited", async () => {
    const pool = new RoutesPool();
    // A project row exists but its ownership is unreadable (a corrupt row / an
    // in-flight ownership migration). The gate cannot resolve an org to sum the
    // cost records under, so the true spend is UNKNOWN.
    pool.seedProject({
      project_id: "proj_null_org",
      org_id: null,
      config: { version: 1, budget: { ceilingUsd: 50, period: "total" } },
    });
    const gate = new PgBudgetGate(pool.asPgPool());

    const state = await gate.resolveBudget("proj_null_org");

    expect(state.failClosed).toBe("unresolvable_project_org");
    expect(state.ceilingUsd).toBeUndefined();
    expect(state.spentUsd).toBe(0);
    expect(shouldPauseOnBudget(state)).toBe(true);
  });

  it("resolves a configured ceiling + sums cost records for a healthy project (regression guard)", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_healthy" });
    pool.seedProject({
      project_id: "proj_healthy",
      org_id: "org_healthy",
      config: { version: 1, budget: { ceilingUsd: 50, period: "total" } },
    });
    pool.seedCostRecord("proj_healthy", 12.5);
    pool.seedCostRecord("proj_healthy", 7.5);
    const gate = new PgBudgetGate(pool.asPgPool());

    const state = await gate.resolveBudget("proj_healthy");

    expect(state.failClosed).toBeUndefined();
    expect(state.ceilingUsd).toBe(50);
    expect(state.spentUsd).toBe(20);
    // Under the ceiling, no fail-closed reason — the walker does NOT pause.
    expect(shouldPauseOnBudget(state)).toBe(false);
  });
});
