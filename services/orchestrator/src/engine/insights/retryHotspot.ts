// `retry_hotspot` compute. Detects writer × spec pairs that have
// been retried at least `retryHotspotMinAttempts` times within the last
// `retryHotspotWindowDays` days, citing the most recent rejection reasons
// from `planner.rerequested` events for that spec.
//
// Inputs derive from the planner-feedback loop: writer tasks land as
// child rows under a planner task with `parent_task_id = plannerTaskId` and
// the `attempt` column carries the writer-retry attempt number. We treat
// distinct writer tasks for the same (specId, cli, model) inside the window
// as the retry signal — both "same task with attempt > 1" and "fresh task
// after planner-rerequested" count.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type Insight, type RetryHotspotPayload } from "./types.js";

export interface ComputeContext {
  projectId: string;
  now?: Date;
  thresholds?: Partial<InsightThresholds>;
}

interface WriterAttemptRow {
  spec_id: string;
  spec_title: string;
  cli: string;
  model: string | null;
  attempt_count: string;
}

interface RejectionRow {
  spec_id: string;
  reason: string;
}

export async function computeRetryHotspot(pool: Pick<pg.Pool, "query">, context: ComputeContext): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };
  const now = context.now ?? new Date();
  const since = new Date(now.getTime() - t.retryHotspotWindowDays * 24 * 60 * 60 * 1000);

  // Count writer attempts per (spec, cli, model) over the window. We count
  // every writer task row — fresh tasks (planner-rerequested) and in-place
  // retries (attempt > 1) both contribute, so a spec retried twice across a
  // planner re-request yields attempt_count = 2.
  const attemptsResult = await pool.query<WriterAttemptRow>(
    `SELECT s.spec_id,
            s.title AS spec_title,
            t.cli,
            t.model,
            COUNT(*)::text AS attempt_count
       FROM tasks t
       INNER JOIN runs r ON r.run_id = t.run_id
       INNER JOIN specs s ON s.spec_id = r.spec_id
       WHERE s.project_id = $1
         AND t.agent_kind = 'writer'
         AND t.started_at >= $2
       GROUP BY s.spec_id, s.title, t.cli, t.model
       HAVING COUNT(*) >= $3`,
    [context.projectId, since, t.retryHotspotMinAttempts],
  );

  if (attemptsResult.rows.length === 0) {
    return [];
  }

  const specIds = [...new Set(attemptsResult.rows.map((r) => r.spec_id))];

  const rejectionsResult = await pool.query<RejectionRow>(
    `SELECT e.spec_id, e.payload->>'rejectionReason' AS reason
       FROM events e
       WHERE e.event_type = 'planner.rerequested'
         AND e.spec_id = ANY($1::text[])
         AND e.ts >= $2
       ORDER BY e.ts DESC`,
    [specIds, since],
  );

  const rejectionsBySpec = new Map<string, string[]>();
  for (const row of rejectionsResult.rows) {
    if (row.reason === null || row.reason === undefined) continue;
    const list = rejectionsBySpec.get(row.spec_id) ?? [];
    if (list.length < 5) list.push(row.reason);
    rejectionsBySpec.set(row.spec_id, list);
  }

  return attemptsResult.rows.map((row) => {
    const retryCount = Number(row.attempt_count);
    const payload: RetryHotspotPayload = {
      kind: "retry_hotspot",
      specId: row.spec_id,
      specTitle: row.spec_title,
      writerCli: row.cli,
      writerModel: row.model ?? "unknown",
      retryCount,
      windowDays: t.retryHotspotWindowDays,
      rejectionSummaries: rejectionsBySpec.get(row.spec_id) ?? [],
    };
    const severity = retryCount >= t.retryHotspotMinAttempts + 1 ? "warn" : "info";
    const title = `${row.spec_title} retried ${retryCount}× in ${t.retryHotspotWindowDays}d`;
    const body =
      payload.rejectionSummaries.length > 0
        ? `Writer (${payload.writerCli} / ${payload.writerModel}) is looping on this spec. Recent rejections: ${payload.rejectionSummaries.join("; ")}`
        : `Writer (${payload.writerCli} / ${payload.writerModel}) has produced ${retryCount} attempts on this spec inside the last ${t.retryHotspotWindowDays} days.`;
    const insightId = `insight_retry_${row.spec_id}_${randomUUID()}`;
    return {
      id: insightId,
      kind: "retry_hotspot",
      projectId: context.projectId,
      severity,
      title,
      body,
      payload,
      actions: [
        {
          label: "Open BDD · refine",
          toolCall: {
            tool: "tanren.create_spec",
            args: {
              projectId: context.projectId,
              title: `Refine: ${row.spec_title}`,
              description: `Refine failing behavior for spec ${row.spec_id}. ${
                payload.rejectionSummaries[0] ?? "Writer kept getting rejected."
              }`,
            },
          },
        },
        {
          label: "Snooze · 24h",
          toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
        },
      ],
      computedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
  });
}
