// The per-project DOLLAR BUDGET surface (autonomy-engine.md §3 proof 6): the
// OBSERVATION + MUTATION endpoints for the budget ceiling the DagWalker enforces.
//
//   GET  /:orgId/projects/:projectId/budget
//     → { ceilingUsd | null, period, gatedFigure, spentUsd, notionalUsd,
//         remainingUsd | null, paused }
//       the resolved ceiling (project-over-org), which figure it gates (real spend),
//       the cumulative REAL spend over the period, the API-EQUIVALENT notional value
//       over the same period (surfaced so a subscription org sees a non-zero figure;
//       NOT spend, NOT gated), the remaining headroom against the gated figure, and
//       whether the walker is paused on budget.
//   PUT  /:orgId/projects/:projectId/budget   { ceilingUsd, period?, gatedFigure? }
//     → the same shape, re-read after the write. Sets the project's OWN budget,
//       read-modify-writing `projects.config.budget` through the SAME versioned
//       project-config path the rest of the config uses — a dedicated, discoverable
//       endpoint so an operator never hand-crafts a full config PATCH to change it.
//       `ceilingUsd: null` CLEARS the project budget (back to the org default /
//       unlimited).
//
// Both run org-scoped under RLS: the spend sum (via PgBudgetGate) reads on the
// org-scoped client; the config write resolves + verifies the project's org first.

import { notifyDagChanged } from "@tanren/db";
import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import {
  type BudgetGatedFigure,
  DEFAULT_BUDGET_GATED_FIGURE,
  DEFAULT_BUDGET_PERIOD,
  migrateProjectConfig,
} from "../../engine/config/index.js";
import { type ProjectBudgetState, shouldPauseOnBudget } from "../../engine/contracts/dagWalker.js";
import { PgBudgetGate } from "../../engine/dag/budgetGate.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";

// `ceilingUsd: null` clears the project's own budget; a number (with optional
// period + gated-figure) sets it. `period` defaults to the same default the config
// schema uses; `gatedFigure` names which figure the ceiling caps and defaults to
// `real_spend` (the figure the DagWalker's gate actually sums).
export const BudgetPutSchema = z
  .object({
    ceilingUsd: z.number().nonnegative().nullable(),
    period: z.enum(["monthly", "quarterly", "annual", "total"]).optional(),
    gatedFigure: z.enum(["real_spend", "notional"]).optional(),
  })
  .strict();

/**
 * The read-shape both GET and PUT return — the apex-proof + operator surface.
 *
 * Vocabulary discipline (FOCUS-aligned): `spentUsd` is REAL money out the door
 * (BilledCost; the figure the ceiling gates). `notionalUsd` is the API-EQUIVALENT,
 * list-priced ESTIMATE (ListCost) over the SAME period — surfaced so a subscription
 * org sees a non-zero figure; it is NOT spend and is NEVER gated. `gatedFigure`
 * names which figure the ceiling caps (always `real_spend` today), so a reader never
 * has to guess; `remainingUsd` is the headroom against THAT gated figure.
 */
export interface BudgetView {
  ceilingUsd: number | null;
  period: "monthly" | "quarterly" | "annual" | "total";
  /** Which figure the ceiling gates (always `real_spend` today). */
  gatedFigure: BudgetGatedFigure;
  /** REAL spend over the period (the gated figure). */
  spentUsd: number;
  /** Notional / API-equivalent value over the same period (NOT spend, NOT gated). */
  notionalUsd: number;
  remainingUsd: number | null;
  paused: boolean;
}

function toView(state: ProjectBudgetState): BudgetView {
  const ceilingUsd = state.ceilingUsd ?? null;
  return {
    ceilingUsd,
    period: state.period,
    gatedFigure: state.gatedFigure,
    spentUsd: state.spentUsd,
    notionalUsd: state.notionalUsd,
    // Headroom is measured against the GATED figure (real spend) — never notional.
    remainingUsd: ceilingUsd === null ? null : Math.max(0, ceilingUsd - state.spentUsd),
    // BUDGET-SAFETY (C1b/M5): a fail-closed safety pause shows as paused too, not
    // just the genuine ceiling-reached case.
    paused: shouldPauseOnBudget(state),
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

  // The PRE-write resolved state — so a ceiling RAISE that re-animates a budget-paused
  // project can fire the re-walk wake below (audit §3.7e).
  const before = await new PgBudgetGate(pool).resolveBudget(projectId);

  const rawConfig = await ProjectStore.getConfig(pool, projectId, systemActor);
  const current = migrateProjectConfig(rawConfig);
  const nextConfig = {
    ...current,
    budget:
      body.ceilingUsd === null
        ? undefined
        : {
            ceilingUsd: body.ceilingUsd,
            period: body.period ?? DEFAULT_BUDGET_PERIOD,
            gatedFigure: body.gatedFigure ?? DEFAULT_BUDGET_GATED_FIGURE,
          },
  };
  // Round-trip through the versioned parser so the persisted blob is always a valid
  // ProjectConfigV1 (drops the `budget` key entirely when cleared — `.strict()`).
  await ProjectStore.updateConfig(pool, projectId, migrateProjectConfig(nextConfig), systemActor);

  const state = await new PgBudgetGate(pool).resolveBudget(projectId);

  // RESUME WAKE (audit §3.7e): the DagWalker is driven by the LISTEN/NOTIFY bus, and a
  // project PAUSED on budget has NO run-terminal / spec-insert notification to re-walk
  // it — so without an explicit wake here, raising the ceiling would leave it paused
  // until the periodic backstop (§3.13a) or a worker reboot. When the write LOOSENS the
  // gate — the project WAS paused and is now NOT (a raised ceiling, a cleared budget, a
  // rolled period) — fire a `tanren_dag` re-walk so the freed headroom is picked up
  // immediately. Best-effort (a NOTIFY failure must not fail the budget write); the
  // backstop tick is the safety net regardless.
  if (shouldPauseOnBudget(before) && !shouldPauseOnBudget(state)) {
    try {
      await notifyDagChanged(pool, projectId);
    } catch (error) {
      console.error(`[budget] failed to emit re-walk wake after un-pausing project ${projectId}:`, error);
    }
  }

  return c.json(toView(state));
}
