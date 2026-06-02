// The pg-backed BudgetGate (autonomy-engine.md §3 proof 6): the DagWalker's
// dollar-budget seam. It resolves a project's configured ceiling — the project's
// own `budget` over the org's `defaultBudget` (project-over-org, exactly how the
// rest of the config layers) — and, when a ceiling is set, sums the project's
// CUMULATIVE SPEND over the configured period from `cost_records` (the dollar
// column `cost_usd`). The walker consults this BEFORE enqueuing: a reached ceiling
// pauses the tick on budget. A project with NO budget configured resolves
// `ceilingUsd: undefined` (unlimited) and skips the sum entirely, so the no-budget
// path is byte-identical to before this gate existed.
//
// Period semantics (the sum window):
//   - `monthly` — the CURRENT CALENDAR MONTH (UTC): records since
//                 `date_trunc('month', now())`. A fresh window opens each month.
//   - `total`   — the project's LIFETIME: every cost record for the project.
//
// RLS: the cost-sum read runs on the ORG-SCOPED client (resolve the project's org
// system-scoped first, then sum under that org). An off-scope read sees zero rows
// (RLS denies by default), so the spend is always exactly the calling org's. This
// mirrors PgDagReadModel's resolve-org-then-read-scoped pattern.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { DEFAULT_BUDGET_PERIOD, type BudgetPeriod } from "../config/index.js";
import { migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { ProjectBudget } from "../config/shared.js";
import type { BudgetGate, ProjectBudgetState } from "../contracts/dagWalker.js";

/**
 * Resolve the EFFECTIVE budget for a project: the project's own `budget` wins; else
 * the org's `defaultBudget`; else undefined (no ceiling). A whole-object override
 * (the project either sets a complete budget or inherits the org's complete one) —
 * matching the `ProjectBudget` shape, which carries a required `ceilingUsd`. An
 * unparseable config blob is treated as "no budget" (unlimited) rather than throwing
 * — the gate must never block the walker on a config read it cannot decode.
 */
export function resolveEffectiveBudget(projectConfigRaw: unknown, orgConfigRaw: unknown): ProjectBudget | undefined {
  const projectBudget = safeBudget(() => migrateProjectConfig(projectConfigRaw).budget);
  if (projectBudget !== undefined) return projectBudget;
  return safeBudget(() => migrateOrgConfig(orgConfigRaw).defaultBudget);
}

function safeBudget(read: () => ProjectBudget | undefined): ProjectBudget | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The pg-backed budget gate the production walker uses. */
export class PgBudgetGate implements BudgetGate {
  constructor(private readonly pool: pg.Pool) {}

  async resolveBudget(projectId: string): Promise<ProjectBudgetState> {
    const owner = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null; config: unknown }>(
        "SELECT org_id, config FROM projects WHERE project_id = $1",
        [projectId],
      );
      const row = result.rows[0];
      return row === undefined ? null : { orgId: row.org_id, projectConfig: row.config };
    });
    if (owner === null || owner.orgId === null) {
      // No resolvable project/org ⇒ no budget the walker can enforce (and the
      // cost-sum read would be denied by RLS anyway). Treat as unlimited.
      return { ceilingUsd: undefined, period: DEFAULT_BUDGET_PERIOD, spentUsd: 0 };
    }
    const orgConfig = await runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
        owner.orgId,
      ]);
      return result.rows[0]?.config;
    });

    const budget = resolveEffectiveBudget(owner.projectConfig, orgConfig);
    if (budget === undefined) {
      // Unlimited: skip the (otherwise unnecessary) spend sum entirely.
      return { ceilingUsd: undefined, period: DEFAULT_BUDGET_PERIOD, spentUsd: 0 };
    }

    const spentUsd = await this.sumSpend(owner.orgId, projectId, budget.period);
    return { ceilingUsd: budget.ceilingUsd, period: budget.period, spentUsd };
  }

  /**
   * Sum the project's `cost_records.cost_usd` over the period, ORG-SCOPED (RLS).
   * `cost_usd` is nullable (cost-unknown is an honest state) — COALESCE skips NULLs;
   * a `monthly` window filters to the current calendar month, `total` sums all rows.
   */
  private async sumSpend(orgId: string, projectId: string, period: BudgetPeriod): Promise<number> {
    const windowClause = period === "monthly" ? " AND recorded_at >= date_trunc('month', now())" : "";
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
           FROM cost_records
          WHERE project_id = $1${windowClause}`,
        [projectId],
      );
      return Number(result.rows[0]?.total ?? "0");
    });
  }
}
