// read-only Forge tool implementations for the `tanren.*` family.
//
// Each tool mirrors one variant of the `ForgeToolCall` discriminated union
// in. v0 wraps the existing repository functions (runs,
// cost recorder, event readers, entity stores).
// Event-shaped data passes through the redaction serializer with
// rawView=false by default; the dashboard's run-detail surface
// is the elevated-view entry point that emits audit events when an admin
// opts into rawView. The `repo.*` family lives in `repo.ts`.

import { z } from "zod";
import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { resolveQueryClient } from "../../data/orgScopedDb.js";
import { BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneStore } from "../../entities/milestones.js";
import { ForgeToolsStore } from "../../repositories/forgeTools.js";
import { systemActor } from "../../state/actor.js";
import { isEventName } from "../../events/index.js";
import { redactEventPayload } from "../../redaction/index.js";
import { assertProjectAccess, assertRunAccess, assertSpecAccess, ToolAccessDeniedError } from "./authz.js";

interface ToolDeps {
  pool: pg.Pool;
}

// The Forge answerer schemas are rendered for OpenAI strict structured outputs,
// where an unset optional arg arrives as an explicit `null` rather than being
// omitted (see renderAnswererJsonSchema). `isSet` collapses both `null` and
// `undefined` to "not provided" so the tool bodies treat them identically.
function isSet<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

// RLS R3a: the forge READ-tool dispatcher runs inside an ambient
// `runWithOrgScope` (the `/forge/tools` route + the ask engine both open one).
// Each tool reads on `resolveQueryClient(deps.pool)` — the ambient org-scoped
// client when a scope is open, else the pool (inert in R1). Entity-store reads
// (behaviors/milestones/insights) take a `QueryClient` and get the same client.

// ---------------------------------------------------------------------------
// `tanren.read_spec`
// ---------------------------------------------------------------------------

export interface TanrenReadSpecResult {
  spec: Record<string, unknown>;
  behaviors: ReadonlyArray<Record<string, unknown>>;
  milestone: Record<string, unknown> | undefined;
}

export async function tanrenReadSpec(
  deps: ToolDeps,
  args: { specId: string },
  actor: ActorContext,
): Promise<TanrenReadSpecResult> {
  const db = resolveQueryClient(deps.pool);
  await assertSpecAccess(db, args.specId, actor);
  const spec = await ForgeToolsStore.getSpecRow(db, args.specId, systemActor);
  if (spec === undefined) {
    throw new ToolAccessDeniedError(`spec not found: ${args.specId}`);
  }
  const behaviors = await BehaviorStore.listForSpec(db, args.specId, actor);
  const milestone = await MilestoneStore.getSpecMilestone(db, args.specId, actor);
  return {
    spec,
    behaviors: behaviors as unknown as ReadonlyArray<Record<string, unknown>>,
    milestone: milestone as unknown as Record<string, unknown> | undefined,
  };
}

// ---------------------------------------------------------------------------
// `tanren.read_run`
// ---------------------------------------------------------------------------

export interface TanrenReadRunResult {
  run: Record<string, unknown>;
  tasks: ReadonlyArray<Record<string, unknown>>;
}

export async function tanrenReadRun(
  deps: ToolDeps,
  args: { runId: string },
  actor: ActorContext,
): Promise<TanrenReadRunResult> {
  const db = resolveQueryClient(deps.pool);
  await assertRunAccess(db, args.runId, actor);
  const run = await ForgeToolsStore.getRunRow(db, args.runId, systemActor);
  if (run === undefined) {
    throw new ToolAccessDeniedError(`run not found: ${args.runId}`);
  }
  const tasks = await ForgeToolsStore.listRunTasks(db, args.runId, systemActor);
  return { run, tasks };
}

// ---------------------------------------------------------------------------
// `tanren.read_events` — applies redaction by default.
// ---------------------------------------------------------------------------

// The optional fields may arrive as `null` (the OpenAI-strict answerer schema
// returns null rather than omitting an optional key); `null` is treated the
// same as an omitted field throughout this function.
export interface TanrenReadEventsArgs {
  runId?: string | null;
  specId?: string | null;
  since?: string | null;
  limit?: number | null;
}

export interface RedactedEventRow {
  id: number | string;
  ts: Date;
  runId: string | null;
  taskId: string | null;
  specId: string | null;
  projectId: string | null;
  eventType: string;
  payload: unknown;
  redactedPaths: string[];
}

// Decode the raw pg `ts` cell at the boundary instead of laundering it with a
// `row["ts"] as Date` cast (the no-pg-as-date enforcement). `z.coerce.date()`
// accepts a `Date` (the pg driver's `timestamptz`) or a string and yields a real
// `Date` — and THROWS on a NULL / garbage cell rather than handing a fake `Date`
// to the consumer. The cast told the type system "this IS a Date" while nothing
// checked it; this checks it.
const EventTimestamp = z.coerce.date();

function decodeEventTs(value: unknown): Date {
  return EventTimestamp.parse(value);
}

export async function tanrenReadEvents(
  deps: ToolDeps,
  args: TanrenReadEventsArgs,
  actor: ActorContext,
): Promise<{ events: RedactedEventRow[] }> {
  // The answerer schema is OpenAI-strict, so an unset optional arrives as `null`
  // (not absent); `isSet` collapses null + undefined to "not provided".
  const runId = isSet(args.runId) ? args.runId : undefined;
  const specId = isSet(args.specId) ? args.specId : undefined;
  const since = isSet(args.since) ? args.since : undefined;
  if (runId === undefined && specId === undefined) {
    throw new ToolAccessDeniedError("read_events requires runId or specId");
  }
  const db = resolveQueryClient(deps.pool);
  if (runId !== undefined) {
    await assertRunAccess(db, runId, actor);
  }
  if (specId !== undefined) {
    await assertSpecAccess(db, specId, actor);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (runId !== undefined) {
    params.push(runId);
    clauses.push(`run_id = $${params.length}`);
  }
  if (specId !== undefined) {
    params.push(specId);
    clauses.push(`spec_id = $${params.length}`);
  }
  if (since !== undefined) {
    params.push(since);
    clauses.push(`ts >= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(args.limit ?? 500, 1000));
  const limitIdx = params.length;
  const rows = await ForgeToolsStore.listEventsForTool(db, where, limitIdx, params, systemActor);
  const events: RedactedEventRow[] = rows.map((row: Record<string, unknown>) => {
    const eventType = String(row["event_type"]);
    if (!isEventName(eventType)) {
      return {
        id: row["id"] as number | string,
        ts: decodeEventTs(row["ts"]),
        runId: row["run_id"] === null || row["run_id"] === undefined ? null : String(row["run_id"]),
        taskId: row["task_id"] === null || row["task_id"] === undefined ? null : String(row["task_id"]),
        specId: row["spec_id"] === null || row["spec_id"] === undefined ? null : String(row["spec_id"]),
        projectId: row["project_id"] === null || row["project_id"] === undefined ? null : String(row["project_id"]),
        eventType,
        payload: row["payload"],
        redactedPaths: [],
      };
    }
    const output = redactEventPayload({
      eventName: eventType,
      payload: row["payload"],
      actor,
      rawView: false,
    });
    return {
      id: row["id"] as number | string,
      ts: decodeEventTs(row["ts"]),
      runId: row["run_id"] === null || row["run_id"] === undefined ? null : String(row["run_id"]),
      taskId: row["task_id"] === null || row["task_id"] === undefined ? null : String(row["task_id"]),
      specId: row["spec_id"] === null || row["spec_id"] === undefined ? null : String(row["spec_id"]),
      projectId: row["project_id"] === null || row["project_id"] === undefined ? null : String(row["project_id"]),
      eventType,
      payload: output.payload,
      redactedPaths: output.redactedPaths,
    };
  });
  return { events };
}

// ---------------------------------------------------------------------------
// `tanren.read_costs`
// ---------------------------------------------------------------------------

// Optional fields may arrive as `null` (OpenAI-strict answerer schema) and are
// treated identically to an omitted field.
export interface TanrenReadCostsArgs {
  runId?: string | null;
  projectId?: string | null;
  since?: string | null;
}

export async function tanrenReadCosts(
  deps: ToolDeps,
  args: TanrenReadCostsArgs,
  actor: ActorContext,
): Promise<{ costs: ReadonlyArray<Record<string, unknown>>; totalUsd: string }> {
  const runId = isSet(args.runId) ? args.runId : undefined;
  const since = isSet(args.since) ? args.since : undefined;
  if (runId === undefined && !isSet(args.projectId)) {
    throw new ToolAccessDeniedError("read_costs requires runId or projectId");
  }
  const db = resolveQueryClient(deps.pool);
  let projectId = isSet(args.projectId) ? args.projectId : undefined;
  if (runId !== undefined) {
    const access = await assertRunAccess(db, runId, actor);
    projectId = projectId ?? access.projectId;
  } else if (projectId !== undefined) {
    await assertProjectAccess(db, projectId, actor);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (runId !== undefined) {
    params.push(runId);
    clauses.push(`run_id = $${params.length}`);
  } else if (projectId !== undefined) {
    params.push(projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (since !== undefined) {
    params.push(since);
    clauses.push(`recorded_at >= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await ForgeToolsStore.listCostsForTool(db, where, params, systemActor);
  // cost_usd is best-effort and may be NULL; null rows contribute nothing to
  // the dollar total but are still returned with their token breakdown.
  const totalUsd = rows.reduce<number>((sum, row) => {
    const value = (row as { cost_usd: string | null }).cost_usd;
    return value === null || value === undefined ? sum : sum + Number(value);
  }, 0);
  return {
    costs: rows as ReadonlyArray<Record<string, unknown>>,
    totalUsd: totalUsd.toFixed(6),
  };
}

// ---------------------------------------------------------------------------
// `tanren.read_behaviors` / `tanren.read_milestones`
// ---------------------------------------------------------------------------

export async function tanrenReadBehaviors(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext,
): Promise<{ behaviors: ReadonlyArray<Record<string, unknown>> }> {
  const db = resolveQueryClient(deps.pool);
  await assertProjectAccess(db, args.projectId, actor);
  // Behaviors are persona-scoped; we list every persona reachable from the
  // project's org and union the behaviors. Matches what the dashboard
  // needs: "all behaviors my project can reference".
  const personaIds = await ForgeToolsStore.listProjectPersonaIds(db, args.projectId, systemActor);
  if (personaIds.length === 0) return { behaviors: [] };
  const behaviors = await ForgeToolsStore.listBehaviorsForPersonas(db, personaIds, systemActor);
  return { behaviors };
}

export async function tanrenReadMilestones(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext,
): Promise<{ milestones: ReadonlyArray<Record<string, unknown>> }> {
  const db = resolveQueryClient(deps.pool);
  const rows = await MilestoneStore.listForProject(db, args.projectId, actor);
  return { milestones: rows as unknown as ReadonlyArray<Record<string, unknown>> };
}

// ---------------------------------------------------------------------------
// `tanren.read_insights` — wraps the compute-on-read dispatcher.
// The dashboard's ⌘K palette and the Forge narration generator both call
// this tool, so a single shared loader keeps the cache hit-rate consistent.
// ---------------------------------------------------------------------------

import { loadInsightsForProject } from "../../insights/index.js";

export async function tanrenReadInsights(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext,
): Promise<{ insights: ReadonlyArray<Record<string, unknown>> }> {
  const db = resolveQueryClient(deps.pool);
  await assertProjectAccess(db, args.projectId, actor);
  const insights = await loadInsightsForProject(db, { projectId: args.projectId });
  return { insights: insights as unknown as ReadonlyArray<Record<string, unknown>> };
}
