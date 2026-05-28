// P2A-0020 read-through cache for typed workflow insights.
//
// The cache lives in `workflow_insights`. Rows are "fresh" when
// `acknowledged_at IS NULL` and `computed_at > NOW() - cacheFreshnessMs`.
// `readFreshOrCompute` is the canonical entry point: it reads any fresh
// rows, and if none exist or every row for the requested kind is stale,
// it invokes `compute()` and refreshes the cache (insert; we do not delete
// stale rows so the audit trail is preserved).
//
// The cache is an *optimization*, not the source of truth — the compute
// function is the source of truth. Re-reading on a partial cache is safe:
// the compute functions are idempotent for a given (project, now) input
// modulo new `id` values.

import type pg from "pg";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";
import { Insight, type InsightKind, type InsightPayload, type InsightSeverity } from "./types.js";

interface CacheRow {
  id: string;
  kind: string;
  project_id: string;
  severity: string;
  payload: unknown;
  computed_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

export async function readFreshInsights(
  pool: Pick<pg.Pool, "query">,
  options: { projectId: string; kind: InsightKind; now?: Date; cacheFreshnessMs?: number }
): Promise<Insight[]> {
  const now = options.now ?? new Date();
  const freshness = options.cacheFreshnessMs ?? DEFAULT_THRESHOLDS.cacheFreshnessMs;
  const cutoff = new Date(now.getTime() - freshness);
  const result = await pool.query<CacheRow>(
    `SELECT id, kind, project_id, severity, payload, computed_at,
            acknowledged_at, acknowledged_by
       FROM workflow_insights
       WHERE project_id = $1
         AND kind = $2
         AND acknowledged_at IS NULL
         AND computed_at > $3
       ORDER BY computed_at DESC`,
    [options.projectId, options.kind, cutoff]
  );
  return result.rows.map(decodeRow);
}

// Storage envelope for a row of `workflow_insights.payload`. The discriminated
// payload itself lives under `data`; the operator-facing title/body and the
// action list live alongside it so a single jsonb fetch reconstructs the
// full `Insight` without a join.
interface PayloadEnvelope {
  data: Record<string, unknown>;
  title: string;
  body: string;
  actions: ReadonlyArray<{ label: string; toolCall: unknown }>;
}

export async function writeInsights(
  pool: Pick<pg.Pool, "query">,
  insights: ReadonlyArray<Insight>
): Promise<void> {
  if (insights.length === 0) return;
  for (const insight of insights) {
    const envelope: PayloadEnvelope = {
      data: insight.payload as unknown as Record<string, unknown>,
      title: insight.title,
      body: insight.body,
      actions: insight.actions
    };
    await pool.query(
      `INSERT INTO workflow_insights
         (id, kind, project_id, severity, payload, computed_at, acknowledged_at, acknowledged_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        insight.id,
        insight.kind,
        insight.projectId,
        insight.severity,
        JSON.stringify(envelope),
        insight.computedAt,
        insight.acknowledgedAt,
        insight.acknowledgedBy
      ]
    );
  }
}

export interface ReadOrComputeOptions {
  projectId: string;
  kind: InsightKind;
  now?: Date;
  cacheFreshnessMs?: number;
  compute: () => Promise<Insight[]>;
}

export async function readFreshOrCompute(
  pool: Pick<pg.Pool, "query">,
  options: ReadOrComputeOptions
): Promise<{ insights: Insight[]; source: "cache" | "compute" }> {
  const fresh = await readFreshInsights(pool, {
    projectId: options.projectId,
    kind: options.kind,
    now: options.now,
    cacheFreshnessMs: options.cacheFreshnessMs
  });
  if (fresh.length > 0) {
    return { insights: fresh, source: "cache" };
  }
  const computed = await options.compute();
  if (computed.length > 0) {
    await writeInsights(pool, computed);
  }
  return { insights: computed, source: "compute" };
}

export async function acknowledgeInsight(
  pool: Pick<pg.Pool, "query">,
  insightId: string,
  actorUserId: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE workflow_insights
       SET acknowledged_at = $2, acknowledged_by = $3
       WHERE id = $1 AND acknowledged_at IS NULL`,
    [insightId, now, actorUserId]
  );
  return (result.rowCount ?? 0) > 0;
}

function decodeRow(row: CacheRow): Insight {
  const envelope = (row.payload ?? {}) as Partial<PayloadEnvelope>;
  const data = (envelope.data ?? { kind: row.kind }) as Record<string, unknown>;
  const title = typeof envelope.title === "string" ? envelope.title : row.kind;
  const body = typeof envelope.body === "string" ? envelope.body : "";
  const actions = Array.isArray(envelope.actions) ? envelope.actions : [];
  return Insight.parse({
    id: row.id,
    kind: row.kind as InsightKind,
    projectId: row.project_id,
    severity: row.severity as InsightSeverity,
    title,
    body,
    payload: data as InsightPayload,
    actions: actions.map((entry) => entry as { label: string; toolCall: unknown }),
    computedAt: row.computed_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by
  });
}
