// data loaders backing the run-detail API surface. Each function
// here decodes raw pg rows into the contract types from contract.ts. The
// route layer composes these; no SQL lives in routes/runs/index.ts.

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
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
import {
  RawCostRowSchema,
  RawEventRowSchema,
  RawRunSummaryRowSchema,
  RawTaskRowSchema,
  scalarText,
  scalarTextOr,
} from "./rowSchemas.js";

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
  // Decode the timestamp columns at the boundary: a real Date (or a parse throw
  // on a malformed row), never a laundered `as Date`.
  const ts = RawRunSummaryRowSchema.parse(raw);
  return RunSummary.parse({
    runId: scalarText(raw.run_id),
    specId: scalarText(raw.spec_id),
    projectId: scalarText(raw.project_id),
    trigger: scalarText(raw.trigger),
    branch: scalarText(raw.branch),
    status: RunStatus.parse(raw.status),
    outcome: raw.outcome === null || raw.outcome === undefined ? null : RunOutcome.parse(raw.outcome),
    startedAt: ts.started_at,
    endedAt: ts.ended_at,
    prUrl: raw.pr_url === null || raw.pr_url === undefined ? null : scalarText(raw.pr_url),
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
  return rows.map((row) => {
    // Decode the (nullable) task timestamps at the boundary into real Dates.
    const ts = RawTaskRowSchema.parse(row);
    return TaskTimelineEntry.parse({
      taskId: scalarText(row["task_id"]),
      runId: scalarText(row["run_id"]),
      kind: TaskKind.parse(row["kind"]),
      parentTaskId:
        row["parent_task_id"] === null || row["parent_task_id"] === undefined
          ? null
          : scalarText(row["parent_task_id"]),
      title: scalarTextOr(row["title"], ""),
      status: TaskStatus.parse(row["status"]),
      outcome: row["outcome"] === null || row["outcome"] === undefined ? null : TaskOutcome.parse(row["outcome"]),
      failureKind:
        row["failure_kind"] === null || row["failure_kind"] === undefined ? null : scalarText(row["failure_kind"]),
      attempt: Number(row["attempt"] ?? 1),
      cli: scalarTextOr(row["cli"], ""),
      model: row["model"] === null || row["model"] === undefined ? null : scalarText(row["model"]),
      startedAt: ts.started_at,
      endedAt: ts.ended_at,
    });
  });
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
    // Decode the cursor-key id + event timestamp at the boundary into a real Date.
    const decoded = RawEventRowSchema.parse(row);
    const eventType = scalarText(row.event_type);
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
      id: decoded.id,
      ts: decoded.ts,
      runId: row.run_id === null || row.run_id === undefined ? null : scalarText(row.run_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : scalarText(row.task_id),
      specId: row.spec_id === null || row.spec_id === undefined ? null : scalarText(row.spec_id),
      projectId: row.project_id === null || row.project_id === undefined ? null : scalarText(row.project_id),
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
  // Cursor from the last DECODED item (ts already a real Date, id narrowed) —
  // not the raw row, so no `as Date` launder.
  const last = items.at(-1);
  const nextCursor = fetched.length > limit && last !== undefined ? encodeCursor({ ts: last.ts, id: last.id }) : null;
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
  // Cursor from the last DECODED item (ts already a real Date, id narrowed).
  const last = items.at(-1);
  const nextCursor = fetched.length > limit && last !== undefined ? encodeCursor({ ts: last.ts, id: last.id }) : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

type CostQueryRow = Record<string, unknown>;

export function decodeCostRow(raw: CostQueryRow): RunCostRecord {
  // Decode id, recorded_at, billing_mode, cost_basis, and token counts at the
  // boundary (a malformed enum / missing timestamp throws here — never a
  // laundered `as` cast). Text identity columns still go through scalarText.
  const decoded = RawCostRowSchema.parse(raw);
  return RunCostRecord.parse({
    id: decoded.id,
    runId: scalarText(raw["run_id"]),
    taskId: scalarText(raw["task_id"]),
    projectId: scalarText(raw["project_id"]),
    cli: scalarText(raw["cli"]),
    provider: scalarText(raw["provider"]),
    model: scalarText(raw["model"]),
    inputTokens: decoded.input_tokens,
    cachedInputTokens: decoded.cached_input_tokens,
    cacheCreationTokens: decoded.cache_creation_tokens,
    outputTokens: decoded.output_tokens,
    reasoningOutputTokens: decoded.reasoning_output_tokens,
    totalTokens: decoded.total_tokens,
    costUsd: raw["cost_usd"] === null || raw["cost_usd"] === undefined ? null : scalarText(raw["cost_usd"]),
    notionalCostUsd:
      raw["notional_cost_usd"] === null || raw["notional_cost_usd"] === undefined
        ? null
        : scalarText(raw["notional_cost_usd"]),
    billingMode: decoded.billing_mode,
    costBasis: decoded.cost_basis,
    recordedAt: decoded.recorded_at,
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
  // Cursor from the last DECODED record (recordedAt already a real Date, id narrowed).
  const last = items.at(-1);
  const nextCursor =
    fetched.length > limit && last !== undefined ? encodeCursor({ ts: last.recordedAt, id: last.id }) : null;
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
  return rows.map((row) => decodeRunListItem(row));
}

type RawRunListProjectionRow = RawRunRow & {
  spec_title?: unknown;
  cost_total_usd?: unknown;
  last_event_at?: unknown;
};

export function decodeRunListItem(row: RawRunListProjectionRow): RunListItem {
  const summary = decodeRunSummary(row);
  const needsReview = summary.prUrl !== null && needsReviewFromOutcome(summary.outcome);
  // Constrained LEFT JOIN can yield null when the run's spec_id does not bind
  // to a same-project/same-org spec. Fail closed at the decoder — never invent
  // a placeholder title that would ship a fabricated HTTP 200 row.
  if (row.spec_title === null || row.spec_title === undefined) {
    throw new TypeError("decodeRunListItem: missing spec_title from constrained run/spec join");
  }
  return RunListItem.parse({
    ...summary,
    specTitle: scalarText(row.spec_title),
    costTotalUsd:
      row.cost_total_usd === null || row.cost_total_usd === undefined ? null : scalarText(row.cost_total_usd),
    lastEventAt: row.last_event_at ?? null,
    needsReview,
  });
}

function needsReviewFromOutcome(outcome: RunListItem["outcome"]): boolean {
  // A run "needs review" when it has an open PR (truthy prUrl) and the outcome
  // indicates the operator must look at it: `ok` is the merge-ready success the
  // operator reviews/merges; the HALTED family (imported from @tanren/db so it
  // stays lock-step with `assertRecoverable`) names a run that stopped short.
  // The prior inline literal check drifted after the SPEC-LOOP REDESIGN added
  // `convergence_stalled` (a halt whose PR still needs review) and after
  // `window_exhausted` joined the halted family — routing the shared set fixes
  // both. A null outcome also counts as needing review when a PR is present.
  if (outcome === null) return true;
  return outcome === "ok" || RECOVERABLE_OUTCOMES.has(outcome);
}
