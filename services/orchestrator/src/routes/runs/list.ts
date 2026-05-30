// P2A-0014: data loaders backing the run-detail API surface. Each function
// here decodes raw pg rows into the contract types from contract.ts. The
// route layer composes these; no SQL lives in routes/runs/index.ts.

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { isEventName } from "../../engine/events/index.js";
import { loadInsightsForProject } from "../../engine/insights/index.js";
import { redactEventPayload } from "../../engine/redaction/index.js";
import { RunOutcome, RunStatus } from "../../engine/state/run.js";
import { TaskKind, TaskOutcome, TaskStatus } from "../../engine/state/task.js";
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
  parsePageSize,
  ProjectFeedItem,
  RunCostRecord,
  RunEventRow,
  RunListItem,
  RunSpecSummary,
  RunSummary,
  TaskTimelineEntry,
} from "./contract.js";
import type { ProjectFeedItem as ProjectFeedItemType, RunDetail } from "./contract.js";

// RLS R1: loaders accept the pool OR an org-scoped client (both expose `.query`).
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;
interface RawRunRow {
  run_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  trigger: unknown;
  branch: unknown;
  status: unknown;
  outcome: unknown;
  pr_url: unknown;
  started_at: unknown;
  ended_at: unknown;
}

function decodeRunSummary(raw: RawRunRow): RunSummary {
  return RunSummary.parse({
    runId: String(raw.run_id),
    specId: String(raw.spec_id),
    projectId: String(raw.project_id),
    trigger: String(raw.trigger),
    branch: String(raw.branch),
    status: RunStatus.parse(raw.status),
    outcome: raw.outcome === null || raw.outcome === undefined ? null : RunOutcome.parse(raw.outcome),
    startedAt: raw.started_at as Date,
    endedAt: raw.ended_at === null || raw.ended_at === undefined ? null : (raw.ended_at as Date),
    prUrl: raw.pr_url === null || raw.pr_url === undefined ? null : String(raw.pr_url),
  });
}

const SELECT_RUN_COLUMNS = `
  run_id, spec_id, project_id, trigger, branch, status, outcome, pr_url, started_at, ended_at
`;

// --- Run summary + tasks ---------------------------------------------------
// orgId is a defense-in-depth tenant predicate: the loaders filter by the
// actor's resolved org (validated route-side via actorCanAccessOrg) so a
// missing/buggy route gate can never leak cross-tenant rows.
export async function fetchRunSummary(
  pool: QueryClient,
  runId: string,
  orgId: string,
): Promise<RunSummary | undefined> {
  const q = `SELECT ${SELECT_RUN_COLUMNS} FROM runs WHERE run_id = $1 AND org_id = $2`;
  const result = await pool.query<RawRunRow>(q, [runId, orgId]);
  return result.rows[0] === undefined ? undefined : decodeRunSummary(result.rows[0]);
}

export async function fetchRunTasks(pool: QueryClient, runId: string, orgId: string): Promise<TaskTimelineEntry[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT task_id, run_id, kind, title, parent_task_id, status, outcome, failure_kind,
            attempt, cli, model, started_at, ended_at
       FROM tasks
      WHERE run_id = $1 AND org_id = $2
      ORDER BY CASE kind
                 WHEN 'plan' THEN 1 WHEN 'write' THEN 2 WHEN 'check' THEN 3
                 WHEN 'audit' THEN 4 WHEN 'ci' THEN 5 ELSE 99
               END,
               started_at ASC NULLS FIRST,
               task_id ASC`,
    [runId, orgId],
  );
  return result.rows.map((row) =>
    TaskTimelineEntry.parse({
      taskId: String(row["task_id"]),
      runId: String(row["run_id"]),
      kind: TaskKind.parse(row["kind"]),
      parentTaskId:
        row["parent_task_id"] === null || row["parent_task_id"] === undefined ? null : String(row["parent_task_id"]),
      title: String(row["title"] ?? ""),
      status: TaskStatus.parse(row["status"]),
      outcome: row["outcome"] === null || row["outcome"] === undefined ? null : TaskOutcome.parse(row["outcome"]),
      failureKind:
        row["failure_kind"] === null || row["failure_kind"] === undefined ? null : String(row["failure_kind"]),
      attempt: Number(row["attempt"] ?? 1),
      cli: String(row["cli"] ?? ""),
      model: row["model"] === null || row["model"] === undefined ? null : String(row["model"]),
      startedAt: row["started_at"] === null || row["started_at"] === undefined ? null : (row["started_at"] as Date),
      endedAt: row["ended_at"] === null || row["ended_at"] === undefined ? null : (row["ended_at"] as Date),
    }),
  );
}

// --- Spec summary (with milestone + behaviors) -----------------------------
export async function fetchRunSpecSummary(pool: QueryClient, specId: string): Promise<RunSpecSummary | undefined> {
  const specResult = await pool.query<{ spec_id: string; title: string; description: string }>(
    "SELECT spec_id, title, description FROM specs WHERE spec_id = $1",
    [specId],
  );
  const spec = specResult.rows[0];
  if (spec === undefined) return undefined;
  const behaviorIds = await fetchBehaviorIds(pool, specId);
  const milestoneId = await fetchSpecMilestone(pool, specId);
  return RunSpecSummary.parse({
    specId: spec.spec_id,
    title: spec.title,
    description: spec.description,
    behaviorIds,
    milestoneId,
  });
}

async function fetchBehaviorIds(pool: QueryClient, specId: string): Promise<string[]> {
  // spec_behaviors table arrived with P2A-0018; older deployments without
  // the table degrade to an empty list rather than 500ing.
  try {
    const result = await pool.query<{ behavior_id: string }>(
      "SELECT behavior_id FROM spec_behaviors WHERE spec_id = $1 ORDER BY behavior_id",
      [specId],
    );
    return result.rows.map((row) => row.behavior_id);
  } catch {
    return [];
  }
}

async function fetchSpecMilestone(pool: QueryClient, specId: string): Promise<string | null> {
  try {
    const result = await pool.query<{ milestone_id: string }>(
      "SELECT milestone_id FROM spec_milestones WHERE spec_id = $1 LIMIT 1",
      [specId],
    );
    return result.rows[0]?.milestone_id ?? null;
  } catch {
    return null;
  }
}

// --- Events (recent for snapshot + paginated) ------------------------------
interface EventQueryRow {
  id: unknown;
  ts: unknown;
  run_id: unknown;
  task_id: unknown;
  spec_id: unknown;
  project_id: unknown;
  event_type: unknown;
  payload: unknown;
}

function applyEventRedaction(
  rows: ReadonlyArray<EventQueryRow>,
  actor: ActorContext | undefined,
  rawView: boolean,
): RunEventRow[] {
  return rows.map((row) => {
    const eventType = String(row.event_type);
    let payload: unknown = row.payload;
    let redactedPaths: string[] = [];
    if (actor !== undefined && isEventName(eventType)) {
      const out = redactEventPayload({
        eventName: eventType,
        payload: row.payload,
        actor,
        rawView,
      });
      payload = out.payload;
      redactedPaths = out.redactedPaths;
    }
    return RunEventRow.parse({
      id: row.id as number | string,
      ts: row.ts as Date,
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      specId: row.spec_id === null || row.spec_id === undefined ? null : String(row.spec_id),
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
      eventType,
      payload,
      redactedPaths,
    });
  });
}

interface SnapshotEventsArgs {
  runId: string;
  orgId: string;
  limit: number;
  actor: ActorContext;
  rawView: boolean;
}

export async function fetchRunEventsForSnapshot(pool: QueryClient, args: SnapshotEventsArgs): Promise<RunEventRow[]> {
  // Most recent N events rendered chronologically; org_id filters by tenant.
  const result = await pool.query<EventQueryRow>(
    `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
       FROM (
         SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
           FROM events
          WHERE run_id = $1 AND org_id = $3
          ORDER BY ts DESC, id DESC
          LIMIT $2
       ) recent
      ORDER BY ts ASC, id ASC`,
    [args.runId, args.limit, args.orgId],
  );
  return applyEventRedaction(result.rows, args.actor, args.rawView);
}

interface EventsPageArgs {
  runId: string;
  orgId: string;
  cursor: string | undefined;
  pageSize: string | undefined;
  actor: ActorContext;
  rawView: boolean;
}

export async function fetchEventsPage(
  pool: QueryClient,
  args: EventsPageArgs,
): Promise<{ items: RunEventRow[]; nextCursor: string | null }> {
  const limit = parsePageSize(args.pageSize);
  const cursor = args.cursor === undefined || args.cursor === "" ? undefined : decodeCursor(args.cursor);
  const params: unknown[] = [args.runId, args.orgId];
  let cursorClause = "";
  if (cursor !== undefined) {
    params.push(cursor.ts, cursor.id);
    cursorClause = ` AND (ts, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  params.push(limit + 1);
  const result = await pool.query<EventQueryRow>(
    `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
       FROM events
      WHERE run_id = $1 AND org_id = $2${cursorClause}
      ORDER BY ts ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, limit);
  const items = applyEventRedaction(rows, args.actor, args.rawView);
  const nextCursor =
    result.rows.length > limit
      ? encodeCursor({
          ts: rows.at(-1)?.ts as Date,
          id: rows.at(-1)?.id as number,
        })
      : null;
  return CursorPage(RunEventRow).parse({ items, nextCursor });
}

// --- Activity feed (paginated, project-wide) -------------------------------
interface FeedPageArgs {
  projectId: string;
  orgId: string;
  cursor: string | undefined;
  pageSize: string | undefined;
  actor: ActorContext;
  rawView: boolean;
}

export async function fetchFeedPage(
  pool: QueryClient,
  args: FeedPageArgs,
): Promise<{ items: ProjectFeedItemType[]; nextCursor: string | null }> {
  const limit = parsePageSize(args.pageSize);
  // Newest-first feed; cursor goes backwards in time, encoding the (ts, id) of
  // the oldest item shown. org_id is a defense-in-depth tenant predicate.
  const cursor = args.cursor === undefined || args.cursor === "" ? undefined : decodeCursor(args.cursor);
  const params: unknown[] = [args.projectId, args.orgId];
  let cursorClause = "";
  if (cursor !== undefined) {
    params.push(cursor.ts, cursor.id);
    cursorClause = ` AND (ts, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  params.push(limit + 1);
  const result = await pool.query<EventQueryRow>(
    `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
       FROM events
      WHERE project_id = $1 AND org_id = $2 AND run_id IS NOT NULL${cursorClause}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, limit);
  const redacted = applyEventRedaction(rows, args.actor, args.rawView);
  // ProjectFeedItem narrows runId to non-null; we already filter at SQL.
  const items = redacted.map((row) => ProjectFeedItem.parse({ ...row, runId: row.runId ?? "" }));
  const nextCursor =
    result.rows.length > limit
      ? encodeCursor({
          ts: rows.at(-1)?.ts as Date,
          id: rows.at(-1)?.id as number,
        })
      : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

type CostQueryRow = Record<string, unknown>;

function decodeCostRow(raw: CostQueryRow): RunCostRecord {
  return RunCostRecord.parse({
    id: raw["id"] as number | string,
    runId: String(raw["run_id"]),
    taskId: String(raw["task_id"]),
    projectId: String(raw["project_id"]),
    cli: String(raw["cli"]),
    provider: String(raw["provider"]),
    model: String(raw["model"]),
    inputTokens: Number(raw["input_tokens"] ?? 0),
    cachedInputTokens: Number(raw["cached_input_tokens"] ?? 0),
    cacheCreationTokens: Number(raw["cache_creation_tokens"] ?? 0),
    outputTokens: Number(raw["output_tokens"] ?? 0),
    reasoningOutputTokens: Number(raw["reasoning_output_tokens"] ?? 0),
    totalTokens: Number(raw["total_tokens"] ?? 0),
    costUsd: raw["cost_usd"] === null || raw["cost_usd"] === undefined ? null : String(raw["cost_usd"]),
    billingMode: raw["billing_mode"] as RunCostRecord["billingMode"],
    costBasis: raw["cost_basis"] as RunCostRecord["costBasis"],
    recordedAt: raw["recorded_at"] as Date,
  });
}

export async function fetchRunCostsForSnapshot(
  pool: QueryClient,
  runId: string,
  orgId: string,
): Promise<RunCostRecord[]> {
  const result = await pool.query<CostQueryRow>(
    `SELECT id, task_id, run_id, project_id, cli, provider, model,
            input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
            cost_usd, billing_mode, cost_basis, recorded_at
       FROM cost_records
      WHERE run_id = $1 AND org_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [runId, orgId],
  );
  return result.rows.map(decodeCostRow);
}

interface CostsPageArgs {
  runId: string;
  orgId: string;
  cursor: string | undefined;
  pageSize: string | undefined;
}

// RLS R2 cohort-2 (cost_records read): widened from pg.Pool to QueryClient so the
// costs page can run on the ambient org-scoped client (the handler wraps it in
// `runWithOrgScope`). Same SQL/params; inert — same rows as the pool path.
export async function fetchCostsPage(
  pool: QueryClient,
  args: CostsPageArgs,
): Promise<{ items: RunCostRecord[]; nextCursor: string | null }> {
  const limit = parsePageSize(args.pageSize);
  const cursor = args.cursor === undefined || args.cursor === "" ? undefined : decodeCursor(args.cursor);
  const params: unknown[] = [args.runId, args.orgId];
  let cursorClause = "";
  if (cursor !== undefined) {
    params.push(cursor.ts, cursor.id);
    cursorClause = ` AND (recorded_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  params.push(limit + 1);
  const result = await pool.query<CostQueryRow>(
    `SELECT id, task_id, run_id, project_id, cli, provider, model,
            input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_output_tokens, total_tokens,
            cost_usd, billing_mode, cost_basis, recorded_at
       FROM cost_records
      WHERE run_id = $1 AND org_id = $2${cursorClause}
      ORDER BY recorded_at ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, limit);
  const items = rows.map(decodeCostRow);
  const nextCursor =
    result.rows.length > limit
      ? encodeCursor({
          ts: rows.at(-1)?.["recorded_at"] as Date,
          id: rows.at(-1)?.["id"] as number,
        })
      : null;
  return CursorPage(RunCostRecord).parse({ items, nextCursor });
}

// ---------------------------------------------------------------------------
// Insights filter to a specific run + spec
// ---------------------------------------------------------------------------

export async function fetchRunInsights(
  pool: pg.Pool,
  projectId: string,
  specId: string,
  runId: string,
): Promise<RunDetail["insights"]> {
  const all = await loadInsightsForProject(pool, { projectId });
  // pace_anomaly carries a runId; retry_hotspot/model_mismatch are spec-class
  // scoped. Filter to the bits relevant to this run.
  return all.filter((insight) => {
    if (insight.payload.kind === "pace_anomaly") {
      return insight.payload.runId === runId;
    }
    if (insight.payload.kind === "retry_hotspot") {
      return insight.payload.specId === specId;
    }
    // model_mismatch is class-level; surface it for any run in the class.
    return true;
  });
}

// ---------------------------------------------------------------------------
// Run list for the project view
// ---------------------------------------------------------------------------

interface RunListArgs {
  projectId: string;
  orgId: string;
  status: string | undefined;
  specId: string | undefined;
}

interface RawRunListRow extends RawRunRow {
  spec_title: string | null;
  cost_total_usd: string | null;
  last_event_at: Date | null;
}

export async function fetchRunListItems(pool: QueryClient, args: RunListArgs): Promise<RunListItem[]> {
  const params: unknown[] = [args.projectId, args.orgId];
  const clauses: string[] = ["r.project_id = $1", "r.org_id = $2"];
  if (args.status !== undefined && args.status !== "") {
    params.push(args.status);
    clauses.push(`r.status = $${params.length}`);
  }
  if (args.specId !== undefined && args.specId !== "") {
    params.push(args.specId);
    clauses.push(`r.spec_id = $${params.length}`);
  }
  const where = clauses.join(" AND ");
  const result = await pool.query<RawRunListRow>(
    `SELECT r.run_id, r.spec_id, r.project_id, r.trigger, r.branch, r.status, r.outcome,
            r.pr_url, r.started_at, r.ended_at,
            s.title AS spec_title,
            (SELECT COALESCE(SUM(cost_usd::numeric), 0)::text
               FROM cost_records WHERE cost_records.run_id = r.run_id) AS cost_total_usd,
            (SELECT MAX(ts) FROM events WHERE events.run_id = r.run_id) AS last_event_at
       FROM runs r
       LEFT JOIN specs s ON s.spec_id = r.spec_id
      WHERE ${where}
      ORDER BY r.started_at DESC, r.run_id ASC`,
    params,
  );
  return result.rows.map((row) => {
    const summary = decodeRunSummary(row);
    const needsReview = summary.prUrl !== null && needsReviewFromOutcome(summary.outcome);
    return RunListItem.parse({
      ...summary,
      specTitle: row.spec_title ?? "(spec missing)",
      costTotalUsd: row.cost_total_usd ?? "0",
      lastEventAt: row.last_event_at ?? null,
      needsReview,
    });
  });
}

function needsReviewFromOutcome(outcome: RunListItem["outcome"]): boolean {
  // A run "needs review" when it has an open PR (truthy prUrl) and the outcome
  // indicates the operator must look at it. The canonical Phase 2 outcomes use
  // `phase2_*_complete` for merge-ready; legacy `pending` / null outcomes also
  // count as needing review when a PR is present.
  if (outcome === null) return true;
  return (
    outcome === "halted" ||
    outcome === "escape_hatch_hit" ||
    outcome === "retry_budget_exhausted" ||
    outcome === "phase1_fixture_complete" ||
    outcome === "phase2_easy_complete" ||
    outcome === "phase2_medium_complete" ||
    outcome === "pending"
  );
}
