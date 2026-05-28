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

export interface RunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
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
  event_type: string;
  payload: unknown;
}

export interface CostRow {
  id: number;
  task_id: string;
  run_id: string;
  project_id: string;
  cli: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: string;
  pricing_mode: string;
  cost_source: string;
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
  forgeThreads: Array<{ id: string; org_id: string; project_id: string | null; run_id: string | null; scope: string; title: string | null; created_at: Date; updated_at: Date; closed_at: Date | null }> = [];
  forgeTurns: Array<{ id: string; thread_id: string; turn_index: number; source: unknown; audience: string; author_kind: string; render: unknown; created_at: Date }> = [];

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
      trigger: input.trigger ?? "cli",
      branch: input.branch ?? "main",
      status: input.status ?? "running",
      outcome: input.outcome ?? null,
      pr_url: input.pr_url ?? null,
      started_at: input.started_at ?? new Date("2026-05-01T00:00:00.000Z"),
      ended_at: input.ended_at ?? null
    };
    this.runs.push(row);
    return row;
  }

  seedTask(input: Partial<TaskRow> & { task_id: string; run_id: string; kind: string }): TaskRow {
    const row: TaskRow = {
      task_id: input.task_id,
      run_id: input.run_id,
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
      ended_at: input.ended_at ?? null
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
      event_type: input.event_type,
      payload: input.payload ?? {}
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
      cli: input.cli ?? "codex",
      provider: input.provider ?? "openai",
      model: input.model ?? "gpt-x",
      input_tokens: input.input_tokens ?? 0,
      output_tokens: input.output_tokens ?? 0,
      cached_tokens: input.cached_tokens ?? 0,
      cost_usd: input.cost_usd ?? "0.001",
      pricing_mode: input.pricing_mode ?? "per_token",
      cost_source: input.cost_source ?? "provider_direct",
      recorded_at: input.recorded_at ?? new Date(2026, 4, 1, 0, 0, input.id)
    };
    this.costs.push(row);
    return row;
  }

  seedSpec(input: Partial<SpecRow> & { spec_id: string; project_id: string }): SpecRow {
    const row: SpecRow = {
      spec_id: input.spec_id,
      project_id: input.project_id,
      title: input.title ?? "Spec",
      description: input.description ?? "spec description"
    };
    this.specs.push(row);
    return row;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const trimmed = sql.trim();

    // assertProjectAccess and friends
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return project === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ org_id: project.org_id }], rowCount: 1 };
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

    // Run snapshot loaders
    if (trimmed.startsWith("SELECT") && /FROM runs WHERE run_id = \$1/.test(trimmed)) {
      const run = this.runs.find((r) => r.run_id === String(params[0]));
      return run === undefined ? { rows: [], rowCount: 0 } : { rows: [run], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT") && /FROM runs/.test(trimmed) && /WHERE/.test(trimmed)) {
      // list loader
      const projectId = String(params[0]);
      const filtered = this.runs
        .filter((r) => r.project_id === projectId)
        .filter((r) => params[1] === undefined || r.status === params[1] || r.spec_id === params[1])
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
              .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
        }));
      return { rows: filtered, rowCount: filtered.length };
    }

    // Tasks list
    if (/FROM tasks\s+WHERE run_id = \$1/.test(trimmed)) {
      const rows = this.tasks
        .filter((t) => t.run_id === String(params[0]))
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
      return milestoneId === undefined ? { rows: [], rowCount: 0 } : { rows: [{ milestone_id: milestoneId }], rowCount: 1 };
    }

    // Events: snapshot
    if (/FROM \(\s*SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload\s+FROM events\s+WHERE run_id = \$1/.test(trimmed)) {
      const limit = Number(params[1]);
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]))
        .sort((a, b) => (b.ts.getTime() - a.ts.getTime()) || (b.id - a.id))
        .slice(0, limit)
        .sort((a, b) => (a.ts.getTime() - b.ts.getTime()) || (a.id - b.id));
      return { rows, rowCount: rows.length };
    }

    // Events: paginated
    if (/FROM events\s+WHERE run_id = \$1(\s+AND \(ts, id\) >|\s+ORDER)/.test(trimmed) && trimmed.includes("ORDER BY ts ASC")) {
      const limit = Number(params[params.length - 1]);
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 4) {
        cursorTs = params[1] as Date;
        cursorId = Number(params[2]);
      }
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]))
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.ts.getTime() > cursorTs.getTime()) return true;
          if (e.ts.getTime() === cursorTs.getTime()) return e.id > cursorId;
          return false;
        })
        .sort((a, b) => (a.ts.getTime() - b.ts.getTime()) || (a.id - b.id))
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Events: SSE polling (id > $2)
    if (/FROM events\s+WHERE run_id = \$1 AND id > \$2/.test(trimmed)) {
      const lastId = Number(params[1]);
      const rows = this.events
        .filter((e) => e.run_id === String(params[0]) && e.id > lastId)
        .sort((a, b) => (a.ts.getTime() - b.ts.getTime()) || (a.id - b.id))
        .slice(0, 200);
      return { rows, rowCount: rows.length };
    }

    // Activity feed
    if (/FROM events\s+WHERE project_id = \$1 AND run_id IS NOT NULL/.test(trimmed)) {
      const limit = Number(params[params.length - 1]);
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 4) {
        cursorTs = params[1] as Date;
        cursorId = Number(params[2]);
      }
      const rows = this.events
        .filter((e) => e.project_id === String(params[0]) && e.run_id !== null)
        .filter((e) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (e.ts.getTime() < cursorTs.getTime()) return true;
          if (e.ts.getTime() === cursorTs.getTime()) return e.id < cursorId;
          return false;
        })
        .sort((a, b) => (b.ts.getTime() - a.ts.getTime()) || (b.id - a.id))
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Costs: snapshot
    if (/FROM cost_records\s+WHERE run_id = \$1\s+ORDER BY recorded_at ASC/.test(trimmed)) {
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]))
        .sort((a, b) => (a.recorded_at.getTime() - b.recorded_at.getTime()) || (a.id - b.id));
      return { rows, rowCount: rows.length };
    }

    // Costs: paginated
    if (/FROM cost_records\s+WHERE run_id = \$1.*ORDER BY recorded_at ASC/.test(trimmed) || /FROM cost_records\s+WHERE run_id = \$1 AND \(recorded_at, id\)/.test(trimmed)) {
      const limit = Number(params[params.length - 1]);
      let cursorTs: Date | undefined;
      let cursorId: number | undefined;
      if (params.length === 4) {
        cursorTs = params[1] as Date;
        cursorId = Number(params[2]);
      }
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]))
        .filter((c) => {
          if (cursorTs === undefined || cursorId === undefined) return true;
          if (c.recorded_at.getTime() > cursorTs.getTime()) return true;
          if (c.recorded_at.getTime() === cursorTs.getTime()) return c.id > cursorId;
          return false;
        })
        .sort((a, b) => (a.recorded_at.getTime() - b.recorded_at.getTime()) || (a.id - b.id))
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // Costs: SSE polling (id > $2)
    if (/FROM cost_records\s+WHERE run_id = \$1 AND id > \$2/.test(trimmed)) {
      const lastId = Number(params[1]);
      const rows = this.costs
        .filter((c) => c.run_id === String(params[0]) && c.id > lastId)
        .sort((a, b) => (a.recorded_at.getTime() - b.recorded_at.getTime()) || (a.id - b.id))
        .slice(0, 200);
      return { rows, rowCount: rows.length };
    }

    // Forge threads list by run
    if (/FROM forge_threads\s+WHERE org_id = \$1 AND project_id = \$2 AND run_id = \$3/.test(trimmed)) {
      const rows = this.forgeThreads.filter(
        (t) => t.org_id === String(params[0]) && t.project_id === String(params[1]) && t.run_id === String(params[2])
      );
      return { rows, rowCount: rows.length };
    }
    if (/FROM forge_threads WHERE id = \$1/.test(trimmed)) {
      const thread = this.forgeThreads.find((t) => t.id === String(params[0]));
      return thread === undefined ? { rows: [], rowCount: 0 } : { rows: [thread], rowCount: 1 };
    }
    if (/FROM forge_turns\s+WHERE thread_id = \$1 AND turn_index > \$2/.test(trimmed)) {
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
    if (/FROM workflow_insights/.test(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO workflow_insights/.test(trimmed) || /UPDATE workflow_insights/.test(trimmed)) {
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
