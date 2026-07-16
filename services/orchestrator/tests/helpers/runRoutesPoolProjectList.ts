/** Project run-list SQL arm extracted from RunRoutesPool to stay under the line cap. */

import type { CostRow, EventRow, QueryResult, RunRow, SpecRow } from "./runRoutesPool.js";

interface ProjectListFixtureState {
  costs: CostRow[];
  events: EventRow[];
  runs: RunRow[];
  specs: SpecRow[];
  projects: Map<string, { project_id: string; org_id: string | null }>;
}

// Canonical production predicates from selectListForProject's constrained join.
// The fake matches the project-list shape, then refuses any SQL that drops the
// project+org join predicates (the former cross-project title-leak bug).
const PROJECT_LIST_SHAPE = /FROM runs r\s+LEFT JOIN specs s/u;
const PROJECT_LIST_WHERE = /r\.project_id = \$1/u;
const PROJECT_LIST_CONSTRAINED_JOIN =
  /LEFT JOIN specs s ON s\.spec_id = r\.spec_id AND s\.project_id = r\.project_id AND s\.org_id = \$2/u;

export function queryProjectListReadModel(
  sql: string,
  params: unknown[],
  state: ProjectListFixtureState,
  completeRealCostTotal: (costs: CostRow[]) => string | null,
): QueryResult | undefined {
  if (!(sql.startsWith("SELECT") && PROJECT_LIST_SHAPE.test(sql) && PROJECT_LIST_WHERE.test(sql))) {
    return undefined;
  }
  if (!PROJECT_LIST_CONSTRAINED_JOIN.test(sql)) {
    throw new Error(
      "project run-list SQL lost its constrained-join predicates " +
        "(s.project_id = r.project_id AND s.org_id = $2); refusing to fake: " +
        sql,
    );
  }
  const projectId = String(params[0]);
  const orgId = String(params[1]);
  const hasStatus = /r\.status = \$/u.test(sql);
  const hasSpec = /r\.spec_id = \$/u.test(sql);
  const filtered = state.runs
    .filter((r) => r.project_id === projectId && r.org_id === orgId)
    .filter((r) => {
      if (!hasStatus && !hasSpec) return true;
      if (hasStatus && hasSpec) return r.status === params[2] && r.spec_id === params[3];
      if (hasStatus) return r.status === params[2];
      return r.spec_id === params[2];
    })
    .map((r) => ({
      ...r,
      spec_title:
        state.specs.find(
          (s) =>
            s.spec_id === r.spec_id &&
            s.project_id === r.project_id &&
            state.projects.get(s.project_id)?.org_id === orgId,
        )?.title ?? null,
      cost_total_usd: completeRealCostTotal(state.costs.filter((c) => c.run_id === r.run_id && c.org_id === orgId)),
      last_event_at:
        state.events
          .filter((e) => e.run_id === r.run_id && e.org_id === orgId)
          .map((e) => e.ts)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    }));
  return { rows: filtered, rowCount: filtered.length };
}
