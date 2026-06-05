// data loaders backing the run-detail API surface. Each function
// here decodes raw pg rows into the contract types from contract.ts. The
// route layer composes these; no SQL lives in routes/runs/index.ts.

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { CostStore, EventStore, RunStore, SpecStore, TaskStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
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

// --- Run summary + tasks ---------------------------------------------------
// orgId is a defense-in-depth tenant predicate: the loaders filter by the
// actor's resolved org (validated route-side via actorCanAccessOrg) so a
// missing/buggy route gate can never leak cross-tenant rows.
export async function fetchRunSummary(
  pool: QueryClient,
  runId: string,
  orgId: string,
): Promise<RunSummary | undefined> {
  const row = await RunStore.selectSummary(pool, runId, orgId, systemActor);
  return row === undefined ? undefined : decodeRunSummary(row as RawRunRow);
}

export async function fetchRunTasks(pool: QueryClient, runId: string, orgId: string): Promise<TaskTimelineEntry[]> {
  const rows = await TaskStore.selectTimeline(pool, runId, orgId, systemActor);
  return rows.map((row) =>
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
  const spec = await SpecStore.selectSummaryHeader(pool, specId, systemActor);
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
  // spec_behaviors table arrived with; older deployments without
  // the table degrade to an empty list rather than 500ing.
  try {
    return await SpecStore.selectBehaviorIds(pool, specId, systemActor);
  } catch {
    return [];
  }
}

async function fetchSpecMilestone(pool: QueryClient, specId: string): Promise<string | null> {
  try {
    return await SpecStore.selectMilestoneId(pool, specId, systemActor);
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
  const rows = await EventStore.selectRecentForRun(
    pool,
    { runId: args.runId, orgId: args.orgId, limit: args.limit },
    systemActor,
  );
  return applyEventRedaction(rows, args.actor, args.rawView);
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
  const fetched = await EventStore.selectPageForRun(
    pool,
    { runId: args.runId, orgId: args.orgId, cursor, limit },
    systemActor,
  );
  const rows = fetched.slice(0, limit);
  const items = applyEventRedaction(rows, args.actor, args.rawView);
  const nextCursor =
    fetched.length > limit
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
  const fetched = await EventStore.selectFeedPageForProject(
    pool,
    { projectId: args.projectId, orgId: args.orgId, cursor, limit },
    systemActor,
  );
  const rows = fetched.slice(0, limit);
  const redacted = applyEventRedaction(rows, args.actor, args.rawView);
  // ProjectFeedItem narrows runId to non-null; we already filter at SQL.
  const items = redacted.map((row) => ProjectFeedItem.parse({ ...row, runId: row.runId ?? "" }));
  const nextCursor =
    fetched.length > limit
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
  const rows = await CostStore.selectForRun(pool, { runId, orgId }, systemActor);
  return rows.map((row) => decodeCostRow(row));
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
  const fetched = await CostStore.selectPageForRun(
    pool,
    { runId: args.runId, orgId: args.orgId, cursor, limit },
    systemActor,
  );
  const rows = fetched.slice(0, limit);
  const items = rows.map((row) => decodeCostRow(row));
  const nextCursor =
    fetched.length > limit
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

export async function fetchRunListItems(pool: QueryClient, args: RunListArgs): Promise<RunListItem[]> {
  const rows = await RunStore.selectListForProject(
    pool,
    { projectId: args.projectId, orgId: args.orgId, status: args.status, specId: args.specId },
    systemActor,
  );
  return rows.map((row) => {
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
  // indicates the operator must look at it. The canonical outcomes use
  // `phase2_*_complete` for merge-ready; a null outcome also counts as needing
  // review when a PR is present.
  if (outcome === null) return true;
  return (
    outcome === "halted" ||
    outcome === "escape_hatch_hit" ||
    outcome === "retry_budget_exhausted" ||
    outcome === "phase1_fixture_complete" ||
    outcome === "phase2_easy_complete" ||
    outcome === "phase2_medium_complete"
  );
}
