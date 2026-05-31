// P2A-0014 test pool. Covers the SQL shapes the run-detail read API emits:
// runs / tasks / events / cost_records / specs / spec_behaviors /
// spec_milestones / project_members / forge_threads / forge_turns /
// workflow_insights / personas / behaviors / milestones.
//
// Each query handler is matched by SQL prefix (the same approach as the
// existing `RoutesPool` helper). The pool is deliberately permissive — if
// no handler matches, an empty result is returned so unrelated code paths
// (e.g. insights cache lookups) do not crash the test.

import type pg from "pg";

function taskKindOrder(kind: string): number {
  return ({ plan: 1, write: 2, check: 3, audit: 4, ci: 5 } as Record<string, number>)[kind] ?? 99;
}

interface QueryResult<R = unknown> {
  rows: R[];
  rowCount: number;
}

// org_id is mandatory on the core tables (tanren tenancy hardening). Rows
// default to this fixture org so seeds stay terse; tests that probe
// cross-tenant isolation override it explicitly.
const DEFAULT_ORG_ID = "org_acme";

export interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  org_id: string;
  trigger: string;
  branch: string;
  status: string;
  outcome: string | null;
  pr_url: string | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface TaskRow {
  task_id: string;
  run_id: string;
  org_id: string;
  kind: string;
  title: string;
  parent_task_id: string | null;
  status: string;
  outcome: string | null;
  failure_kind: string | null;
  attempt: number;
  cli: string;
  model: string | null;
  started_at: Date | null;
  ended_at: Date | null;
}

export interface EventRow {
  id: number;
  ts: Date;
  run_id: string | null;
  task_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  org_id: string;
  event_type: string;
  payload: unknown;
}

export interface CostRow {
  id: number;
  task_id: string;
  run_id: string;
  project_id: string;
  org_id: string;
  cli: string;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cost_usd: string | null;
  billing_mode: string;
  cost_basis: string;
  recorded_at: Date;
}

export interface SpecRow {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
}

export class RunRoutesPool {
  runs: RunRow[] = [];
  tasks: TaskRow[] = [];
  events: EventRow[] = [];
  costs: CostRow[] = [];
  specs: SpecRow[] = [];
  specBehaviors = new Map<string, string[]>();
  specMilestones = new Map<string, string>();
  projects = new Map<string, { project_id: string; org_id: string | null }>();
  projectMembers = new Set<string>();
  forgeThreads: Array<{
    id: string;
    org_id: string;
    project_id: string | null;
    run_id: string | null;
    scope: string;
    title: string | null;
    created_at: Date;
    updated_at: Date;
    closed_at: Date | null;
  }> = [];
  forgeTurns: Array<{
    id: string;
    thread_id: string;
    turn_index: number;
    source: unknown;
    audience: string;
    author_kind: string;
    render: unknown;
    created_at: Date;
  }> = [];

  seedProject(input: { project_id: string; org_id: string | null }): void {
    this.projects.set(input.project_id, input);
  }

  seedProjectMember(projectId: string, userId: string): void {
    this.projectMembers.add(`${projectId}:${userId}`);
  }

  seedRun(input: Partial<RunRow> & { run_id: string; spec_id: string; project_id: string }): RunRow {
    const row: RunRow = {
      run_id: input.run_id,
      spec_id: input.spec_id,
      project_id: input.project_id,
      org_id: input.org_id ?? this.projects.get(input.project_id)?.org_id ?? DEFAULT_ORG_ID,
      trigger: input.trigger ?? "cli",
      branch: input.branch ?? "main",
      status: input.status ?? "running",
      outcome: input.outcome ?? null,
      pr_url: input.pr_url ?? null,
      started_at: input.started_at ?? new Date("2026-05-01T00:00:00.000Z"),
      ended_at: input.ended_at ?? null,
    };
    this.runs.push(row);
    return row;
  }

  seedTask(input: Partial<TaskRow> & { task_id: string; run_id: string; kind: string }): TaskRow {
    const row: TaskRow = {
      task_id: input.task_id,
      run_id: input.run_id,
      org_id: input.org_id ?? this.runs.find((r) => r.run_id === input.run_id)?.org_id ?? DEFAULT_ORG_ID,
      kind: input.kind,
      title: input.title ?? input.kind,
      parent_task_id: input.parent_task_id ?? null,
      status: input.status ?? "running",
      outcome: input.outcome ?? null,
      failure_kind: input.failure_kind ?? null,
      attempt: input.attempt ?? 1,
      cli: input.cli ?? "codex",
      model: input.model ?? null,
      started_at: input.started_at ?? null,
      ended_at: input.ended_at ?? null,
    };
    this.tasks.push(row);
    return row;
  }

  seedEvent(input: Partial<EventRow> & { id: number; event_type: string }): EventRow {
    const row: EventRow = {
      id: input.id,
      ts: input.ts ?? new Date(2026, 4, 1, 0, 0, input.id),
      run_id: input.run_id ?? null,
      task_id: input.task_id ?? null,
      spec_id: input.spec_id ?? null,
      project_id: input.project_id ?? null,
      org_id:
        input.org_id ??
        (input.project_id === undefined ? undefined : this.projects.get(input.project_id)?.org_id) ??
        DEFAULT_ORG_ID,
      event_type: input.event_type,
      payload: input.payload ?? {},
    };
    this.events.push(row);
    return row;
  }

  seedCost(input: Partial<CostRow> & { id: number; run_id: string; task_id: string; project_id: string }): CostRow {
    const row: CostRow = {
      id: input.id,
      task_id: input.task_id,
      run_id: input.run_id,
      project_id: input.project_id,
      org_id: input.org_id ?? this.runs.find((r) => r.run_id === input.run_id)?.org_id ?? DEFAULT_ORG_ID,
      cli: input.cli ?? "codex",
      provider: input.provider ?? "openai",
      model: input.model ?? "gpt-x",
      input_tokens: input.input_tokens ?? 0,
      cached_input_tokens: input.cached_input_tokens ?? 0,
      cache_creation_tokens: input.cache_creation_tokens ?? 0,
      output_tokens: input.output_tokens ?? 0,
      reasoning_output_tokens: input.reasoning_output_tokens ?? 0,
      total_tokens: input.total_tokens ?? 0,
      cost_usd: input.cost_usd ?? "0.001",
      billing_mode: input.billing_mode ?? "per_token",
      cost_basis: input.cost_basis ?? "provider_pricing",
      recorded_at: input.recorded_at ?? new Date(2026, 4, 1, 0, 0, input.id),
    };
    this.costs.push(row);
    return row;
  }

  seedSpec(input: Partial<SpecRow> & { spec_id: string; project_id: string }): SpecRow {
    const row: SpecRow = {
      spec_id: input.spec_id,
      project_id: input.project_id,
      title: input.title ?? "Spec",
      description: input.description ?? "spec description",
    };
    this.specs.push(row);
    return row;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const trimmed = sql.trim();

    // assertProjectAccess and friends
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: project.org_id }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const ok = this.projectMembers.has(`${String(params[0])}:${String(params[1])}`);
      return ok ? { rows: [{ role: "member" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT project_id, spec_id FROM runs WHERE run_id = $1")) {
      const run = this.runs.find((r) => r.run_id === String(params[0]));
      return run === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ project_id: run.project_id, spec_id: run.spec_id }], rowCount: 1 };
    }

    // Run snapshot loaders. org_id is the second predicate (defense-in-depth).
    if (trimmed.startsWith("SELECT") && /FROM runs WHERE run_id = \$1 AND org_id = \$2/u.test(trimmed)) {
      const run = this.runs.find((r) => r.run_id === String(params[0]) && r.org_id === String(params[1]));
      return run === undefined ? { rows: [], rowCount: 0 } : { rows: [run], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT") && /FROM runs/u.test(trimmed) && /WHERE/u.test(trimmed)) {
      // list loader: params are [projectId, orgId, ...status/spec filters].
      const projectId = String(params[0]);
      const orgId = String(params[1]);
      const filtered = this.runs
        .filter((r) => r.project_id === projectId && r.org_id === orgId)
        .filter((r) => params[2] === undefined || r.status === params[2] || r.spec_id === params[2])
        .map((r) => ({
          ...r,
          spec_title: this.specs.find((s) => s.spec_id === r.spec_id)?.title ?? null,
          cost_total_usd: this.costs
            .filter((c) => c.run_id === r.run_id)
            .reduce((sum, c) => sum + Number(c.cost_usd), 0)
            .toString(),
          last_event_at:
            this.events
              .filter((e) => e.run_id === r.run_id)
              .map((e) => e.ts)
              .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
        }));
      return { rows: filtered, rowCount: filtered.length };
    }

    // Tasks list (run_id = $1 AND org_id = $2)
    if (/FROM tasks\s+WHERE run_id = \$1 AND org_id = \$2/u.test(trimmed)) {
      const rows = this.tasks
        .filter((t) => t.run_id === String(params[0]) && t.org_id === String(params[1]))
        .sort((a, b) => {
          if (taskKindOrder(a.kind) !== taskKindOrder(b.kind)) {
            return taskKindOrder(a.kind) - taskKindOrder(b.kind);
          }
          const aT = a.started_at?.getTime() ?? 0;
          const bT = b.started_at?.getTime() ?? 0;
          if (aT !== bT) return aT - bT;
          return a.task_id.localeCompare(b.task_id);
        });
      return { rows, rowCount: rows.length };
    }

    // Spec read
    if (trimmed.startsWith("SELECT spec_id, title, description FROM specs WHERE spec_id = $1")) {
      const spec = this.specs.find((s) => s.spec_id === String(params[0]));
      return spec === undefined ? { rows: [], rowCount: 0 } : { rows: [spec], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT behavior_id FROM spec_behaviors")) {
      const ids = this.specBehaviors.get(String(params[0])) ?? [];
      return { rows: ids.map((behavior_id) => ({ behavior_id })), rowCount: ids.length };
    }
    if (trimmed.startsWith("SELECT milestone_id FROM spec_milestones")) {
      const milestoneId = this.specMilestones.get(String(params[0]));
      return milestoneId === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ milestone_id: milestoneId }], rowCount: 1 };
    }

    // Events: snapshot (run_id = $1 AND org_id = $3; params [runId, limit, orgId])
    if (
      /FROM \(\s*SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload\s+FROM events\s+WHERE run_id = \$1 AND org_id = \$3/u.test(
        trimmed,
      )
    ) {
      const limit = Number(params[1]);
      const orgId = String(params[2]);
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]) && e.org_id === orgId)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
        .slice(0, limit)
        .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id);
      return { rows, rowCount: rows.length };
    }

    // Events: paginated (run_id = $1 AND org_id = $2; params [runId, orgId, ...cursor, limit])
    if (
      /FROM events\s+WHERE run_id = \$1 AND org_id = \$2(\s+AND \(ts, id\) >|\s+ORDER)/u.test(trimmed) &&
      trimmed.includes("ORDER BY ts ASC")
    ) {
      const orgId = String(params[1]);
      const limit = Number(params.at(-1));
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 5) {
        cursorTs = params[2] as Date;
        cursorId = Number(params[3]);
      }
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]) && e.org_id === orgId)
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.ts.getTime() > cursorTs.getTime()) return true;
          if (e.ts.getTime() === cursorTs.getTime()) return e.id > cursorId;
          return false;
        })
        .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Events: SSE polling (run_id = $1 AND org_id = $3 AND id > $2)
    if (/FROM events\s+WHERE run_id = \$1 AND org_id = \$3 AND id > \$2/u.test(trimmed)) {
      const lastId = Number(params[1]);
      const orgId = String(params[2]);
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]) && e.org_id === orgId && e.id > lastId)
        .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)
        .slice(0, 200);
      return { rows, rowCount: rows.length };
    }

    // Activity feed (project_id = $1 AND org_id = $2 AND run_id IS NOT NULL)
    if (/FROM events\s+WHERE project_id = \$1 AND org_id = \$2 AND run_id IS NOT NULL/u.test(trimmed)) {
      const orgId = String(params[1]);
      const limit = Number(params.at(-1));
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 5) {
        cursorTs = params[2] as Date;
        cursorId = Number(params[3]);
      }
      const rows = this.events
        .filter((e) => e.project_id === String(params[0]) && e.org_id === orgId && e.run_id !== null)
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.ts.getTime() < cursorTs.getTime()) return true;
          if (e.ts.getTime() === cursorTs.getTime()) return e.id < cursorId;
          return false;
        })
        .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Costs: snapshot (run_id = $1 AND org_id = $2)
    if (/FROM cost_records\s+WHERE run_id = \$1 AND org_id = \$2\s+ORDER BY recorded_at ASC/u.test(trimmed)) {
      const orgId = String(params[1]);
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]) && c.org_id === orgId)
        .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || a.id - b.id);
      return { rows, rowCount: rows.length };
    }

    // Costs: paginated (run_id = $1 AND org_id = $2; params [runId, orgId, ...cursor, limit])
    if (
      /FROM cost_records\s+WHERE run_id = \$1 AND org_id = \$2.*ORDER BY recorded_at ASC/u.test(trimmed) ||
      /FROM cost_records\s+WHERE run_id = \$1 AND org_id = \$2 AND \(recorded_at, id\)/u.test(trimmed)
    ) {
      const orgId = String(params[1]);
      const limit = Number(params.at(-1));
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 5) {
        cursorTs = params[2] as Date;
        cursorId = Number(params[3]);
      }
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]) && c.org_id === orgId)
        .filter((c) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (c.recorded_at.getTime() > cursorTs.getTime()) return true;
          if (c.recorded_at.getTime() === cursorTs.getTime()) return c.id > cursorId;
          return false;
        })
        .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || a.id - b.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Costs: SSE polling (run_id = $1 AND org_id = $3 AND id > $2)
    if (/FROM cost_records\s+WHERE run_id = \$1 AND org_id = \$3 AND id > \$2/u.test(trimmed)) {
      const lastId = Number(params[1]);
      const orgId = String(params[2]);
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]) && c.org_id === orgId && c.id > lastId)
        .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || a.id - b.id)
        .slice(0, 200);
      return { rows, rowCount: rows.length };
    }

    // Forge threads list by run
    if (/FROM forge_threads\s+WHERE org_id = \$1 AND project_id = \$2 AND run_id = \$3/u.test(trimmed)) {
      const rows = this.forgeThreads.filter(
        (t) => t.org_id === String(params[0]) && t.project_id === String(params[1]) && t.run_id === String(params[2]),
      );
      return { rows, rowCount: rows.length };
    }
    if (/FROM forge_threads WHERE id = \$1/u.test(trimmed)) {
      const thread = this.forgeThreads.find((t) => t.id === String(params[0]));
      return thread === undefined ? { rows: [], rowCount: 0 } : { rows: [thread], rowCount: 1 };
    }
    if (/FROM forge_turns\s+WHERE thread_id = \$1 AND turn_index > \$2/u.test(trimmed)) {
      const sinceIndex = Number(params[1]);
      const limit = Number(params[2]);
      const rows = this.forgeTurns
        .filter((t) => t.thread_id === String(params[0]) && t.turn_index > sinceIndex)
        .sort((a, b) => a.turn_index - b.turn_index)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // workflow_insights table (P2A-0020). Return empty rows so the cache
    // walks to the compute path which itself walks our other tables.
    if (/FROM workflow_insights/u.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO workflow_insights/u.test(trimmed) || /UPDATE workflow_insights/u.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }

    // P2A-0020 retry_hotspot / model_mismatch / pace_anomaly compute helpers
    // query runs/tasks/events directly — return empty so the insight list
    // is [] in tests by default (we explicitly test the filter elsewhere).
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<RunRoutesPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}
