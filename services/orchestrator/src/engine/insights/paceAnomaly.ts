// `pace_anomaly` compute. Compares the elapsed time of in-flight
// writer-subtask tasks against the class average over the last
// `paceAnomalyWindowDays` days of same-class completed subtasks. Emits one
// insight per in-flight task whose elapsed-time multiplier crosses the
// configured threshold (default 2.0).
//
// "Class" is the spec's milestone label (same grouping key as
// model_mismatch). In-flight is `tasks.status = 'running'` and
// `tasks.started_at IS NOT NULL`. The class average uses
// `(ended_at - started_at)` from completed writer tasks in the same class.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type ComputeContext } from "./retryHotspot.js";
import { type Insight, type PaceAnomalyPayload } from "./types.js";

interface InFlightRow {
  task_id: string;
  run_id: string;
  spec_id: string;
  spec_title: string;
  spec_class: string;
  started_at: Date;
  parent_task_id: string | null;
}

interface ClassAverageRow {
  spec_class: string;
  avg_seconds: string;
  samples: string;
}

export async function computePaceAnomaly(pool: Pick<pg.Pool, "query">, context: ComputeContext): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };
  const now = context.now ?? new Date();
  const windowSince = new Date(now.getTime() - t.paceAnomalyWindowDays * 24 * 60 * 60 * 1000);

  // Find currently running writer subtasks for this project. Subtasks land
  // as tasks with `parent_task_id` pointing at a planner task; the writer's
  // agent_kind is 'writer'. We also accept top-level writer tasks for the
  // legacy non-subtask shape so the pace metric still applies during
  // mid-Phase-2 transitional runs.
  const inFlightResult = await pool.query<InFlightRow>(
    `SELECT t.task_id,
            t.run_id,
            r.spec_id,
            s.title AS spec_title,
            COALESCE(m.label, 'unclassified') AS spec_class,
            t.started_at,
            t.parent_task_id
       FROM tasks t
       INNER JOIN runs r ON r.run_id = t.run_id
       INNER JOIN specs s ON s.spec_id = r.spec_id
       LEFT JOIN spec_milestones sm ON sm.spec_id = s.spec_id
       LEFT JOIN milestones m ON m.id = sm.milestone_id
       WHERE r.project_id = $1
         AND t.agent_kind = 'writer'
         AND t.status = 'running'
         AND t.started_at IS NOT NULL`,
    [context.projectId],
  );
  if (inFlightResult.rows.length === 0) return [];

  const classes = [...new Set(inFlightResult.rows.map((r) => r.spec_class))];
  const averagesResult = await pool.query<ClassAverageRow>(
    `SELECT COALESCE(m.label, 'unclassified') AS spec_class,
            AVG(EXTRACT(EPOCH FROM (t.ended_at - t.started_at)))::text AS avg_seconds,
            COUNT(*)::text AS samples
       FROM tasks t
       INNER JOIN runs r ON r.run_id = t.run_id
       INNER JOIN specs s ON s.spec_id = r.spec_id
       LEFT JOIN spec_milestones sm ON sm.spec_id = s.spec_id
       LEFT JOIN milestones m ON m.id = sm.milestone_id
       WHERE r.project_id = $1
         AND t.agent_kind = 'writer'
         AND t.status = 'done'
         AND t.outcome = 'passed'
         AND t.started_at IS NOT NULL
         AND t.ended_at IS NOT NULL
         AND t.ended_at >= $2
         AND COALESCE(m.label, 'unclassified') = ANY($3::text[])
       GROUP BY COALESCE(m.label, 'unclassified')
       HAVING COUNT(*) >= $4`,
    [context.projectId, windowSince, classes, t.paceAnomalyMinSamples],
  );

  const averages = new Map<string, number>();
  for (const row of averagesResult.rows) {
    averages.set(row.spec_class, Number(row.avg_seconds));
  }

  const insights: Insight[] = [];
  for (const row of inFlightResult.rows) {
    const classAverage = averages.get(row.spec_class);
    if (classAverage === undefined || classAverage <= 0) continue;
    const elapsed = (now.getTime() - row.started_at.getTime()) / 1000;
    const multiplier = elapsed / classAverage;
    if (multiplier < t.paceAnomalyMultiplier) continue;
    const subtaskIndex = row.parent_task_id === null ? 0 : await readSubtaskIndex(pool, row.task_id);
    const payload: PaceAnomalyPayload = {
      kind: "pace_anomaly",
      runId: row.run_id,
      taskId: row.task_id,
      subtaskIndex,
      elapsedSeconds: Math.round(elapsed),
      classAverageSeconds: Math.round(classAverage),
      multiplier: Math.round(multiplier * 100) / 100,
      specClass: row.spec_class,
    };
    const insightId = `insight_pace_${row.task_id}_${randomUUID()}`;
    insights.push({
      id: insightId,
      kind: "pace_anomaly",
      projectId: context.projectId,
      severity: multiplier >= t.paceAnomalyMultiplier * 1.5 ? "warn" : "info",
      title: `${row.spec_title}: ${multiplier.toFixed(1)}× slower than ${row.spec_class} average`,
      body: `Run ${row.run_id} writer task has been running ${humanDuration(elapsed)} (class avg ${humanDuration(classAverage)}).`,
      payload,
      actions: [
        {
          label: "Open run",
          toolCall: { tool: "tanren.read_run", args: { runId: row.run_id } },
        },
        {
          label: "Acknowledge",
          toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
        },
      ],
      computedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  }
  return insights;
}

async function readSubtaskIndex(pool: Pick<pg.Pool, "query">, taskId: string): Promise<number> {
  // The subtask index lives in `writer.subtask.started` events. We probe the
  // most recent event for this task; if the writer hasn't emitted that event
  // yet (or this is a legacy non-subtask writer task) we fall back to 0.
  const result = await pool.query<{ index: number | null }>(
    `SELECT (payload->>'subtaskIndex')::int AS index
       FROM events
       WHERE task_id = $1 AND event_type = 'writer.subtask.started'
       ORDER BY ts DESC LIMIT 1`,
    [taskId],
  );
  return result.rows[0]?.index ?? 0;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round((seconds / 3600) * 10) / 10}h`;
}
