// Spec header / behavior / milestone SQL for the run-detail fake pool.
// Constrained to the authorized (spec_id, project_id, org_id) triple.

export interface SpecPoolState {
  specs: ReadonlyArray<{ spec_id: string; project_id: string; title: string; description: string }>;
  projects: Map<string, { project_id: string; org_id: string | null }>;
  specBehaviors: Map<string, string[]>;
  specMilestones: Map<string, string>;
  /** When set, behavior reads throw (fail-loud proof). */
  behaviorReadError?: Error;
  /** When set, milestone reads throw (fail-loud proof). */
  milestoneReadError?: Error;
}

export interface SpecQueryResult {
  rows: unknown[];
  rowCount: number;
}

function tripleBinds(state: SpecPoolState, specId: string, projectId: string, orgId: string): boolean {
  const project = state.projects.get(projectId);
  return state.specs.some(
    (s) => s.spec_id === specId && s.project_id === projectId && project !== undefined && project.org_id === orgId,
  );
}

/** Match constrained run-detail spec SQL. Returns undefined when SQL is unrelated. */
export function queryRunDetailSpec(
  trimmed: string,
  params: unknown[],
  state: SpecPoolState,
): SpecQueryResult | undefined {
  if (
    trimmed.startsWith(
      "SELECT spec_id, title, description FROM specs WHERE spec_id = $1 AND project_id = $2 AND org_id = $3",
    )
  ) {
    const spec = state.specs.find(
      (s) =>
        s.spec_id === String(params[0]) &&
        s.project_id === String(params[1]) &&
        tripleBinds(state, String(params[0]), String(params[1]), String(params[2])),
    );
    return spec === undefined ? { rows: [], rowCount: 0 } : { rows: [spec], rowCount: 1 };
  }
  if (
    trimmed.startsWith("SELECT spec_id, title, description FROM specs WHERE spec_id = $1") &&
    !/project_id/u.test(trimmed)
  ) {
    throw new Error("runRoutesPool: unconstrained spec-header SELECT is not allowed");
  }
  if (/FROM spec_behaviors sb\s+INNER JOIN specs s ON s\.spec_id = sb\.spec_id/u.test(trimmed)) {
    if (state.behaviorReadError !== undefined) throw state.behaviorReadError;
    const ok = tripleBinds(state, String(params[0]), String(params[1]), String(params[2]));
    const ids = ok ? (state.specBehaviors.get(String(params[0])) ?? []) : [];
    return { rows: ids.map((behavior_id) => ({ behavior_id })), rowCount: ids.length };
  }
  if (/FROM spec_milestones sm\s+INNER JOIN specs s ON s\.spec_id = sm\.spec_id/u.test(trimmed)) {
    if (state.milestoneReadError !== undefined) throw state.milestoneReadError;
    const ok = tripleBinds(state, String(params[0]), String(params[1]), String(params[2]));
    const milestoneId = ok ? state.specMilestones.get(String(params[0])) : undefined;
    return milestoneId === undefined
      ? { rows: [], rowCount: 0 }
      : { rows: [{ milestone_id: milestoneId }], rowCount: 1 };
  }
  return undefined;
}
