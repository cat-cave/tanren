/** Org-cost SQL arms extracted from RunRoutesPool to keep the shared fake lean. */

import type { CostRow, EventRow, QueryResult, RunRow, SpecRow } from "./runRoutesPool.js";

interface OrgCostsFixtureState {
  costs: CostRow[];
  events: EventRow[];
  runs: RunRow[];
  specs: SpecRow[];
  projects: Map<string, { project_id: string; org_id: string | null }>;
}

// Canonical production predicates from selectCostListPageForOrg's run/spec
// LEFT JOIN. The fake matches the org-costs run page by the (shape, WHERE)
// pair, then refuses any SQL that drops or alters the constrained-join
// predicates — otherwise dropping `s.project_id = r.project_id AND
// s.org_id = $1` from production SQL would let a cross-project spec id
// fabricate a row and this fake would mask the regression (the audit gap).
const ORG_RUN_PAGE_SHAPE = /FROM runs r\s+LEFT JOIN specs s/u;
const ORG_RUN_PAGE_WHERE = /WHERE r\.org_id = \$1/u;
const ORG_RUN_PAGE_CONSTRAINED_JOIN =
  /LEFT JOIN specs s ON s\.spec_id = r\.spec_id AND s\.project_id = r\.project_id AND s\.org_id = \$1/u;

export function queryOrgCostsReadModel(
  sql: string,
  params: unknown[],
  state: OrgCostsFixtureState,
): QueryResult | undefined {
  if (/FROM cost_records\s+WHERE org_id = \$1/u.test(sql) && /ORDER BY recorded_at ASC, id ASC/u.test(sql)) {
    const cursorAt = params.length === 4 ? (params[1] as Date) : undefined;
    const cursorId = params.length === 4 ? BigInt(String(params[2])) : undefined;
    const limit = Number(params.at(-1));
    const rows = state.costs
      .filter((cost) => cost.org_id === String(params[0]))
      .filter((cost) => {
        if (cursorAt === undefined || cursorId === undefined) return true;
        if (cost.recorded_at.getTime() > cursorAt.getTime()) return true;
        return cost.recorded_at.getTime() === cursorAt.getTime() && BigInt(cost.id) > cursorId;
      })
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || compareBigintText(a.id, b.id))
      .slice(0, limit);
    return { rows, rowCount: rows.length };
  }
  if (!ORG_RUN_PAGE_SHAPE.test(sql)) return undefined;
  // Project list (selectListForProject) also has `FROM runs r LEFT JOIN specs s`
  // but scopes by `r.project_id = $1 AND r.org_id = $2` (and joins with $2 for
  // org). Neither org-costs marker (`WHERE r.org_id = $1` alone, or the $1
  // constrained join) is present, so it falls through to the list loader.
  // Anything that carries one org-costs marker is declaring itself an
  // org-costs run page — then both markers must be present and canonical.
  const looksLikeOrgCostsRunPage = ORG_RUN_PAGE_CONSTRAINED_JOIN.test(sql) || ORG_RUN_PAGE_WHERE.test(sql);
  if (!looksLikeOrgCostsRunPage) return undefined;
  if (!ORG_RUN_PAGE_WHERE.test(sql)) {
    throw new Error(`org-costs run-page SQL lost its WHERE r.org_id = $1 predicate: ${sql}`);
  }
  if (!ORG_RUN_PAGE_CONSTRAINED_JOIN.test(sql)) {
    throw new Error(
      "org-costs run-page SQL lost its constrained-join predicates " +
        "(s.project_id = r.project_id AND s.org_id = $1); refusing to fake: " +
        sql,
    );
  }
  const orgId = String(params[0]);
  const cursorAt = params.length === 4 ? (params[1] as Date) : undefined;
  const cursorRunId = params.length === 4 ? String(params[2]) : undefined;
  const limit = Number(params.at(-1));
  const rows = state.runs
    .filter((run) => run.org_id === orgId)
    .filter((run) => {
      if (cursorAt === undefined || cursorRunId === undefined) return true;
      if (run.started_at.getTime() < cursorAt.getTime()) return true;
      return run.started_at.getTime() === cursorAt.getTime() && run.run_id > cursorRunId;
    })
    .map((run) => ({
      ...run,
      spec_title:
        state.specs.find(
          (spec) =>
            spec.spec_id === run.spec_id &&
            spec.project_id === run.project_id &&
            state.projects.get(spec.project_id)?.org_id === orgId,
        )?.title ?? null,
      cost_total_usd: completeCostTotal(
        state.costs.filter((cost) => cost.run_id === run.run_id && cost.org_id === orgId),
      ),
      last_event_at:
        state.events
          .filter((event) => event.run_id === run.run_id && event.org_id === orgId)
          .map((event) => event.ts)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    }))
    .sort((a, b) => b.started_at.getTime() - a.started_at.getTime() || a.run_id.localeCompare(b.run_id))
    .slice(0, limit);
  return { rows, rowCount: rows.length };
}

function compareBigintText(left: number | string, right: number | string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function completeCostTotal(costs: CostRow[]): string | null {
  if (costs.length === 0) return "0";
  if (costs.some((cost) => cost.cost_usd === null)) return null;
  return costs.reduce((sum, cost) => sum + Number(cost.cost_usd), 0).toString();
}
