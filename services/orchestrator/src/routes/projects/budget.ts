// The per-project DOLLAR BUDGET surface (autonomy-engine.md §3 proof 6): the
// OBSERVATION + MUTATION endpoints for the budget ceiling the DagWalker enforces.
//
//   GET  /:orgId/projects/:projectId/budget
//     → { ceilingUsd | null, period, spentUsd, remainingUsd | null, paused }
//       the resolved ceiling (project-over-org), the cumulative spend over the
//       period, the remaining headroom, and whether the walker is paused on budget.
//   PUT  /:orgId/projects/:projectId/budget   { ceilingUsd, period? }
//     → the same shape, re-read after the write. Sets the project's OWN budget,
//       read-modify-writing `projects.config.budget` through the SAME versioned
//       project-config path the rest of the config uses — a dedicated, discoverable
//       endpoint so an operator never hand-crafts a full config PATCH to change it.
//       `ceilingUsd: null` CLEARS the project budget (back to the org default /
//       unlimited).
//
// Both run org-scoped under RLS: the spend sum (via PgBudgetGate) reads on the
// org-scoped client; the config write resolves + verifies the project's org first.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import { DEFAULT_BUDGET_PERIOD, migrateProjectConfig } from "../../engine/config/index.js";
import { isBudgetExhausted } from "../../engine/contracts/dagWalker.js";
import { PgBudgetGate } from "../../engine/dag/budgetGate.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";

// `ceilingUsd: null` clears the project's own budget; a number (with optional
// period) sets it. `period` defaults to the same default the config schema uses.
export const BudgetPutSchema = z
  .object({
    ceilingUsd: z.number().nonnegative().nullable(),
    period: z.enum(["monthly", "total"]).optional(),
  })
  .strict();

/** The read-shape both GET and PUT return — the apex-proof + operator surface. */
export interface BudgetView {
  ceilingUsd: number | null;
  period: "monthly" | "total";
  spentUsd: number;
  remainingUsd: number | null;
  paused: boolean;
}

function toView(state: { ceilingUsd: number | undefined; period: "monthly" | "total"; spentUsd: number }): BudgetView {
  const ceilingUsd = state.ceilingUsd ?? null;
  return {
    ceilingUsd,
    period: state.period,
    spentUsd: state.spentUsd,
    remainingUsd: ceilingUsd === null ? null : Math.max(0, ceilingUsd - state.spentUsd),
    paused: isBudgetExhausted(state),
  };
}

/** GET handler: resolve the project's budget state + render the observation view. */
export async function handleBudgetGet(c: Context, pool: pg.Pool, orgId: string, projectId: string): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }
  const state = await new PgBudgetGate(pool).resolveBudget(projectId);
  return c.json(toView(state));
}

/**
 * PUT handler: set (or clear) the project's OWN budget by read-modify-writing
 * `projects.config.budget`, then re-read + return the resolved view. `ceilingUsd:
 * null` removes the project budget (the org default / unlimited then applies).
 */
export async function handleBudgetPut(
  c: Context,
  pool: pg.Pool,
  orgId: string,
  projectId: string,
  body: z.infer<typeof BudgetPutSchema>,
): Promise<Response> {
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined || (ownership.orgId !== null && ownership.orgId !== orgId)) {
    return c.json({ error: "project_not_found" }, 404);
  }

  const rawConfig = await ProjectStore.getConfig(pool, projectId, systemActor);
  const current = migrateProjectConfig(rawConfig);
  const nextConfig = {
    ...current,
    budget:
      body.ceilingUsd === null
        ? undefined
        : { ceilingUsd: body.ceilingUsd, period: body.period ?? DEFAULT_BUDGET_PERIOD },
  };
  // Round-trip through the versioned parser so the persisted blob is always a valid
  // ProjectConfigV1 (drops the `budget` key entirely when cleared — `.strict()`).
  await ProjectStore.updateConfig(pool, projectId, migrateProjectConfig(nextConfig), systemActor);

  const state = await new PgBudgetGate(pool).resolveBudget(projectId);
  return c.json(toView(state));
}
