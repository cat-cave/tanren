// P2A-0020 in-memory pg substitute for the workflow-insights compute and
// cache layer. Mirrors the other helper memory clients: only the SQL shapes
// emitted by `services/orchestrator/src/engine/insights/**` are handled.
//
// The client lets a test seed runs, specs, tasks, cost_records, events,
// milestones, and spec_milestones; the SQL the insight compute functions
// emit is interpreted directly against those in-memory tables. The cache
// table (`workflow_insights`) is also modeled here so the read-through
// behavior can be exercised end to end without a real database.

interface QueryResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

export interface SeedSpec {
  spec_id: string;
  title: string;
  project_id: string;
  status?: string;
}

export interface SeedSpecDependency {
  from_spec_id: string;
  to_spec_id: string;
}

export interface SeedRun {
  run_id: string;
  spec_id: string;
  project_id: string;
  outcome: string | null;
  ended_at: Date | null;
}

export interface SeedTask {
  task_id: string;
  run_id: string;
  agent_kind: string;
  cli: string;
  model: string | null;
  status: string;
  outcome: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  attempt: number;
  parent_task_id: string | null;
}

export interface SeedCost {
  task_id: string;
  run_id: string;
  cli: string;
  model: string;
  cost_usd: number;
  recorded_at: Date;
}

export interface SeedMilestone {
  id: string;
  project_id: string;
  label: string;
}

export interface SeedSpecMilestone {
  spec_id: string;
  milestone_id: string;
}

export interface SeedEvent {
  spec_id: string | null;
  task_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  ts: Date;
}

export interface SeedInsightRow {
  id: string;
  kind: string;
  project_id: string;
  severity: string;
  payload: Record<string, unknown>;
  computed_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

export class InsightsMemoryClient {
  specs: SeedSpec[] = [];
  specDependencies: SeedSpecDependency[] = [];
  runs: SeedRun[] = [];
  tasks: SeedTask[] = [];
  costs: SeedCost[] = [];
  milestones: SeedMilestone[] = [];
  specMilestones: SeedSpecMilestone[] = [];
  events: SeedEvent[] = [];
  insights: SeedInsightRow[] = [];

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult> {
    const t = sql.trim();
    if (t.startsWith("INSERT INTO workflow_insights")) {
      const payload = JSON.parse(String(params[4])) as Record<string, unknown>;
      const row: SeedInsightRow = {
        id: String(params[0]),
        kind: String(params[1]),
        project_id: String(params[2]),
        severity: String(params[3]),
        payload,
        computed_at: params[5] as Date,
        acknowledged_at: (params[6] ?? null) as Date | null,
        acknowledged_by: (params[7] ?? null) as string | null
      };
      const existing = this.insights.find((entry) => entry.id === row.id);
      if (existing === undefined) this.insights.push(row);
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith("UPDATE workflow_insights")) {
      const id = String(params[0]);
      const ackAt = params[1] as Date;
      const ackBy = String(params[2]);
      const row = this.insights.find((entry) => entry.id === id);
      if (row === undefined || row.acknowledged_at !== null) {
        return { rows: [], rowCount: 0 };
      }
      row.acknowledged_at = ackAt;
      row.acknowledged_by = ackBy;
      return { rows: [], rowCount: 1 };
    }
    if (
      t.startsWith("SELECT id, kind, project_id, severity, payload, computed_at") &&
      t.includes("FROM workflow_insights")
    ) {
      const projectId = String(params[0]);
      const kind = String(params[1]);
      const cutoff = params[2] as Date;
      const rows = this.insights
        .filter(
          (entry) =>
            entry.project_id === projectId &&
            entry.kind === kind &&
            entry.acknowledged_at === null &&
            entry.computed_at.getTime() > cutoff.getTime()
        )
        .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime());
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT s.spec_id,") && t.includes("FROM tasks t")) {
      // retry_hotspot writer-attempts query
      const projectId = String(params[0]);
      const since = params[1] as Date;
      const minAttempts = Number(params[2]);
      const buckets = new Map<string, { spec_id: string; spec_title: string; cli: string; model: string | null; count: number }>();
      for (const task of this.tasks) {
        if (task.agent_kind !== "writer") continue;
        if (task.started_at === null) continue;
        if (task.started_at.getTime() < since.getTime()) continue;
        const run = this.runs.find((entry) => entry.run_id === task.run_id);
        if (run === undefined || run.project_id !== projectId) continue;
        const spec = this.specs.find((entry) => entry.spec_id === run.spec_id);
        if (spec === undefined) continue;
        const key = `${spec.spec_id}|${task.cli}|${task.model ?? ""}`;
        const existing = buckets.get(key);
        if (existing === undefined) {
          buckets.set(key, {
            spec_id: spec.spec_id,
            spec_title: spec.title,
            cli: task.cli,
            model: task.model,
            count: 1
          });
        } else {
          existing.count += 1;
        }
      }
      const rows = [...buckets.values()]
        .filter((bucket) => bucket.count >= minAttempts)
        .map((bucket) => ({
          spec_id: bucket.spec_id,
          spec_title: bucket.spec_title,
          cli: bucket.cli,
          model: bucket.model,
          attempt_count: String(bucket.count)
        }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT e.spec_id, e.payload->>'rejectionReason' AS reason")) {
      const specIds = params[0] as string[];
      const since = params[1] as Date;
      const rows = this.events
        .filter(
          (event) =>
            event.event_type === "planner.rerequested" &&
            event.spec_id !== null &&
            specIds.includes(event.spec_id) &&
            event.ts.getTime() >= since.getTime()
        )
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())
        .map((event) => ({ spec_id: event.spec_id, reason: String(event.payload.rejectionReason ?? "") }));
      return { rows, rowCount: rows.length };
    }
    if (t.includes("WITH merged_runs") && t.includes("class_lookup")) {
      // model_mismatch query
      const projectId = String(params[0]);
      const since = params[1] as Date;
      const minMerged = Number(params[2]);
      const mergedRuns = this.runs.filter(
        (run) =>
          run.project_id === projectId &&
          run.outcome === "merged" &&
          run.ended_at !== null &&
          run.ended_at.getTime() >= since.getTime()
      );
      const classByRun = new Map<string, { spec_class: string; spec_id: string }>();
      for (const run of mergedRuns) {
        const sm = this.specMilestones.find((entry) => entry.spec_id === run.spec_id);
        if (sm === undefined) continue;
        const m = this.milestones.find((entry) => entry.id === sm.milestone_id);
        if (m === undefined) continue;
        classByRun.set(run.run_id, { spec_class: m.label, spec_id: run.spec_id });
      }
      const buckets = new Map<
        string,
        { spec_class: string; cli: string; model: string; cost: number; specs: Set<string>; last: Date }
      >();
      for (const cost of this.costs) {
        const lookup = classByRun.get(cost.run_id);
        if (lookup === undefined) continue;
        const task = this.tasks.find((entry) => entry.task_id === cost.task_id);
        if (task === undefined || task.agent_kind !== "writer") continue;
        const key = `${lookup.spec_class}|${cost.cli}|${cost.model}`;
        const existing = buckets.get(key);
        if (existing === undefined) {
          buckets.set(key, {
            spec_class: lookup.spec_class,
            cli: cost.cli,
            model: cost.model,
            cost: cost.cost_usd,
            specs: new Set([lookup.spec_id]),
            last: cost.recorded_at
          });
        } else {
          existing.cost += cost.cost_usd;
          existing.specs.add(lookup.spec_id);
          if (cost.recorded_at.getTime() > existing.last.getTime()) existing.last = cost.recorded_at;
        }
      }
      const rows = [...buckets.values()]
        .filter((bucket) => bucket.specs.size >= minMerged)
        .map((bucket) => ({
          spec_class: bucket.spec_class,
          cli: bucket.cli,
          model: bucket.model,
          merged_specs: String(bucket.specs.size),
          total_cost: String(bucket.cost),
          last_used_at: bucket.last
        }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT t.task_id,") && t.includes("FROM tasks t") && t.includes("status = 'running'")) {
      // paceAnomaly in-flight query
      const projectId = String(params[0]);
      const rows: Array<Record<string, unknown>> = [];
      for (const task of this.tasks) {
        if (task.agent_kind !== "writer" || task.status !== "running" || task.started_at === null) continue;
        const run = this.runs.find((entry) => entry.run_id === task.run_id);
        if (run === undefined || run.project_id !== projectId) continue;
        const spec = this.specs.find((entry) => entry.spec_id === run.spec_id);
        if (spec === undefined) continue;
        const sm = this.specMilestones.find((entry) => entry.spec_id === spec.spec_id);
        const milestone = sm === undefined ? undefined : this.milestones.find((entry) => entry.id === sm.milestone_id);
        rows.push({
          task_id: task.task_id,
          run_id: task.run_id,
          spec_id: spec.spec_id,
          spec_title: spec.title,
          spec_class: milestone?.label ?? "unclassified",
          started_at: task.started_at,
          parent_task_id: task.parent_task_id
        });
      }
      return { rows, rowCount: rows.length };
    }
    if (t.includes("AVG(EXTRACT(EPOCH FROM (t.ended_at - t.started_at)))")) {
      const projectId = String(params[0]);
      const since = params[1] as Date;
      const classes = params[2] as string[];
      const minSamples = Number(params[3]);
      const buckets = new Map<string, { total: number; count: number }>();
      for (const task of this.tasks) {
        if (task.agent_kind !== "writer") continue;
        if (task.status !== "done" || task.outcome !== "passed") continue;
        if (task.started_at === null || task.ended_at === null) continue;
        if (task.ended_at.getTime() < since.getTime()) continue;
        const run = this.runs.find((entry) => entry.run_id === task.run_id);
        if (run === undefined || run.project_id !== projectId) continue;
        const spec = this.specs.find((entry) => entry.spec_id === run.spec_id);
        if (spec === undefined) continue;
        const sm = this.specMilestones.find((entry) => entry.spec_id === spec.spec_id);
        const milestone = sm === undefined ? undefined : this.milestones.find((entry) => entry.id === sm.milestone_id);
        const cls = milestone?.label ?? "unclassified";
        if (!classes.includes(cls)) continue;
        const existing = buckets.get(cls) ?? { total: 0, count: 0 };
        existing.total += (task.ended_at.getTime() - task.started_at.getTime()) / 1000;
        existing.count += 1;
        buckets.set(cls, existing);
      }
      const rows = [...buckets.entries()]
        .filter(([, agg]) => agg.count >= minSamples)
        .map(([cls, agg]) => ({
          spec_class: cls,
          avg_seconds: String(agg.total / agg.count),
          samples: String(agg.count)
        }));
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT (payload->>'subtaskIndex')::int AS index")) {
      const taskId = String(params[0]);
      const row = this.events
        .filter((event) => event.event_type === "writer.subtask.started" && event.task_id === taskId)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())[0];
      if (row === undefined) return { rows: [], rowCount: 0 };
      return { rows: [{ index: Number(row.payload.subtaskIndex ?? 0) }], rowCount: 1 };
    }
    if (t.startsWith("SELECT d.from_spec_id,") && t.includes("FROM spec_dependencies d")) {
      // stuck dependency-edge query
      const projectId = String(params[0]);
      const rows: Array<Record<string, unknown>> = [];
      for (const edge of this.specDependencies) {
        const from = this.specs.find((s) => s.spec_id === edge.from_spec_id);
        const to = this.specs.find((s) => s.spec_id === edge.to_spec_id);
        if (from === undefined || to === undefined) continue;
        if (from.project_id !== projectId) continue;
        rows.push({
          from_spec_id: from.spec_id,
          from_title: from.title,
          from_status: from.status ?? "pending",
          to_spec_id: to.spec_id,
          to_title: to.title,
          to_status: to.status ?? "pending"
        });
      }
      return { rows, rowCount: rows.length };
    }
    if (t.startsWith("SELECT e.spec_id,") && t.includes("FROM events e") && t.includes("INNER JOIN specs s")) {
      // review_stall review/merge-event query
      const projectId = String(params[0]);
      const types = params[1] as string[];
      const rows = this.events
        .filter((event) => {
          if (event.spec_id === null) return false;
          if (!types.includes(event.event_type)) return false;
          const spec = this.specs.find((s) => s.spec_id === event.spec_id);
          return spec !== undefined && spec.project_id === projectId;
        })
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())
        .map((event) => {
          const spec = this.specs.find((s) => s.spec_id === event.spec_id);
          const prNumber = event.payload.prNumber;
          const prUrl = event.payload.prUrl;
          return {
            spec_id: event.spec_id,
            spec_title: spec?.title ?? event.spec_id,
            event_type: event.event_type,
            ts: event.ts,
            pr_number: typeof prNumber === "number" ? prNumber : null,
            pr_url: typeof prUrl === "string" ? prUrl : null
          };
        });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}
