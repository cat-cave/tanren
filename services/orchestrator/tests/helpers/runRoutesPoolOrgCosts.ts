/** Org-cost SQL arms extracted from RunRoutesPool to keep the shared fake lean. */

import type { CostRow, EventRow, QueryResult, RunRow, SpecRow } from "./runRoutesPool.js";

interface OrgCostsFixtureState {
  costs: CostRow[];
  events: EventRow[];
  runs: RunRow[];
  specs: SpecRow[];
  projects: Map<string, { project_id: string; org_id: string | null }>;
}

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
  if (!/FROM runs r\s+LEFT JOIN specs s/u.test(sql) || !/WHERE r\.org_id = \$1/u.test(sql)) {
    return undefined;
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
