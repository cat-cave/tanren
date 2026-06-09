// `review_stall` compute. Derives from the review/merge event
// stream (`review.requested`, `review.changes_requested`, `review.approved`,
// `merge.completed`). A PR is stalled when its most recent review/merge signal
// is a `review.requested` (awaiting a verdict) or `review.changes_requested`
// (the author has gone quiet on requested changes) AND that signal landed more
// than `reviewStallHours` ago with no subsequent approval or merge.
//
// Events are grouped per spec (the `events.spec_id` column). The latest
// review/merge event per spec is the decisive one; if it is approved or
// merged, the spec is moving and we stay silent. Reported from existing rows
// only — no migration to the source data.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { DEFAULT_THRESHOLDS, type InsightThresholds } from "./thresholds.js";
import { type ComputeContext } from "./retryHotspot.js";
import { type Insight, type ReviewStallPayload } from "./types.js";

const REVIEW_EVENT_TYPES = [
  "review.requested",
  "review.changes_requested",
  "review.approved",
  "merge.completed",
] as const;

interface ReviewEventRow {
  spec_id: string;
  spec_title: string;
  event_type: string;
  ts: Date;
  pr_number: number | null;
  pr_url: string | null;
}

// Generous hard row cap on the review-event scan. With the time window already
// bounding the lookback, this is a belt-and-suspenders guard against a pathological
// project that floods review events inside the window — the query stays O(cap),
// never lifetime-wide. Ordered newest-first, so the decisive (latest) event per
// spec is always retained even if older events are truncated.
const REVIEW_EVENT_SCAN_LIMIT = 10_000;

export async function computeReviewStall(pool: Pick<pg.Pool, "query">, context: ComputeContext): Promise<Insight[]> {
  const t: InsightThresholds = { ...DEFAULT_THRESHOLDS, ...context.thresholds };
  const now = context.now ?? new Date();
  // BOUND the scan: only review/merge events inside the lookback window. Without
  // this, the query read EVERY review event over the project's lifetime (no time
  // bound, no LIMIT — audit §4.3 worst case). The window is generous vs the 48h
  // stall threshold so a real stall is never missed.
  const since = new Date(now.getTime() - t.reviewStallWindowDays * 24 * 60 * 60 * 1000);

  // Pull recent review/merge events for the project's specs, newest first, so a
  // single pass can pick the decisive (latest) event per spec. Bounded on BOTH a
  // time window (`e.ts >= $3`) AND a row LIMIT.
  const result = await pool.query<ReviewEventRow>(
    `SELECT e.spec_id,
            s.title AS spec_title,
            e.event_type,
            e.ts,
            (e.payload->>'prNumber')::int AS pr_number,
            e.payload->>'prUrl'           AS pr_url
       FROM events e
       INNER JOIN specs s ON s.spec_id = e.spec_id
       WHERE s.project_id = $1
         AND e.spec_id IS NOT NULL
         AND e.event_type = ANY($2::text[])
         AND e.ts >= $3
       ORDER BY e.ts DESC
       LIMIT ${REVIEW_EVENT_SCAN_LIMIT}`,
    [context.projectId, REVIEW_EVENT_TYPES, since],
  );
  if (result.rows.length === 0) return [];

  // First (newest) row seen per spec is the decisive one.
  const latestBySpec = new Map<string, ReviewEventRow>();
  for (const row of result.rows) {
    if (!latestBySpec.has(row.spec_id)) latestBySpec.set(row.spec_id, row);
  }

  const insights: Insight[] = [];
  for (const row of latestBySpec.values()) {
    const phase =
      row.event_type === "review.requested"
        ? "awaiting_review"
        : row.event_type === "review.changes_requested"
          ? "changes_requested"
          : null;
    // latest signal is approved/merged — moving.
    if (phase === null) continue;

    const stalledHours = (now.getTime() - row.ts.getTime()) / (60 * 60 * 1000);
    if (stalledHours < t.reviewStallHours) continue;

    const payload: ReviewStallPayload = {
      kind: "review_stall",
      specId: row.spec_id,
      specTitle: row.spec_title,
      prNumber: row.pr_number ?? 0,
      prUrl: row.pr_url ?? "",
      phase,
      stalledHours: Math.round(stalledHours * 10) / 10,
      thresholdHours: t.reviewStallHours,
    };
    const insightId = `insight_review_${row.spec_id}_${randomUUID()}`;
    const phaseLabel = phase === "awaiting_review" ? "awaiting review" : "changes requested";
    const prRef = payload.prNumber > 0 ? `PR #${payload.prNumber}` : "the PR";
    insights.push({
      id: insightId,
      kind: "review_stall",
      projectId: context.projectId,
      severity: stalledHours >= t.reviewStallHours * 2 ? "warn" : "info",
      title: `${row.spec_title}: ${prRef} ${phaseLabel} for ${humanHours(stalledHours)}`,
      body: `${prRef} has been ${phaseLabel} for ${humanHours(stalledHours)} (threshold ${t.reviewStallHours}h) with no approval or merge.`,
      payload,
      actions: [
        {
          label: "Open PR",
          toolCall: { tool: "tanren.read_run", args: { specId: row.spec_id } },
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

function humanHours(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}
