// P2A-0019: read-only Forge tool implementations for the `tanren.*` family.
//
// Each tool mirrors one variant of the `ForgeToolCall` discriminated union
// in P2A-0008. v0 wraps the existing repository functions (P2A-0005 runs,
// P2A-0011 cost recorder, P2A-0014 event readers, P2A-0018 entity stores).
// Event-shaped data passes through the P2A-0009 redaction serializer with
// rawView=false by default; the dashboard's run-detail surface (P2A-0014)
// is the elevated-view entry point that emits audit events when an admin
// opts into rawView. The `repo.*` family lives in `repo.ts`.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneStore } from "../../entities/milestones.js";
import { isEventName } from "../../events/index.js";
import { redactEventPayload } from "../../redaction/index.js";
import { assertProjectAccess, assertRunAccess, assertSpecAccess, ToolAccessDeniedError } from "./authz.js";

interface ToolDeps {
  pool: pg.Pool;
}

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
  actor: ActorContext
): Promise<TanrenReadSpecResult> {
  await assertSpecAccess(deps.pool, args.specId, actor);
  const specResult = await deps.pool.query<Record<string, unknown>>(
    "SELECT * FROM specs WHERE spec_id = $1",
    [args.specId]
  );
  const spec = specResult.rows[0];
  if (spec === undefined) {
    throw new ToolAccessDeniedError(`spec not found: ${args.specId}`);
  }
  const behaviors = await BehaviorStore.listForSpec(deps.pool, args.specId, actor);
  const milestone = await MilestoneStore.getSpecMilestone(deps.pool, args.specId, actor);
  return {
    spec,
    behaviors: behaviors as unknown as ReadonlyArray<Record<string, unknown>>,
    milestone: milestone as unknown as Record<string, unknown> | undefined
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
  actor: ActorContext
): Promise<TanrenReadRunResult> {
  await assertRunAccess(deps.pool, args.runId, actor);
  const runResult = await deps.pool.query<Record<string, unknown>>(
    "SELECT * FROM runs WHERE run_id = $1",
    [args.runId]
  );
  const run = runResult.rows[0];
  if (run === undefined) {
    throw new ToolAccessDeniedError(`run not found: ${args.runId}`);
  }
  const tasks = await deps.pool.query<Record<string, unknown>>(
    `SELECT * FROM tasks WHERE run_id = $1
     ORDER BY started_at ASC NULLS FIRST, task_id ASC`,
    [args.runId]
  );
  return { run, tasks: tasks.rows };
}

// ---------------------------------------------------------------------------
// `tanren.read_events` — applies P2A-0009 redaction by default.
// ---------------------------------------------------------------------------

export interface TanrenReadEventsArgs {
  runId?: string;
  specId?: string;
  since?: string;
  limit?: number;
}

export interface RedactedEventRow {
  id: number | string;
  ts: Date | string;
  runId: string | null;
  taskId: string | null;
  specId: string | null;
  projectId: string | null;
  eventType: string;
  payload: unknown;
  redactedPaths: string[];
}

export async function tanrenReadEvents(
  deps: ToolDeps,
  args: TanrenReadEventsArgs,
  actor: ActorContext
): Promise<{ events: RedactedEventRow[] }> {
  if (args.runId === undefined && args.specId === undefined) {
    throw new ToolAccessDeniedError("read_events requires runId or specId");
  }
  if (args.runId !== undefined) {
    await assertRunAccess(deps.pool, args.runId, actor);
  }
  if (args.specId !== undefined) {
    await assertSpecAccess(deps.pool, args.specId, actor);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.runId !== undefined) {
    params.push(args.runId);
    clauses.push(`run_id = $${params.length}`);
  }
  if (args.specId !== undefined) {
    params.push(args.specId);
    clauses.push(`spec_id = $${params.length}`);
  }
  if (args.since !== undefined) {
    params.push(args.since);
    clauses.push(`ts >= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(args.limit ?? 500, 1000));
  const limitIdx = params.length;
  const result = await deps.pool.query(
    `SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload
     FROM events
     ${where}
     ORDER BY ts ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );
  const events: RedactedEventRow[] = result.rows.map((row: Record<string, unknown>) => {
    const eventType = String(row.event_type);
    if (!isEventName(eventType)) {
      return {
        id: row.id as number | string,
        ts: row.ts as Date,
        runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
        taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
        specId: row.spec_id === null || row.spec_id === undefined ? null : String(row.spec_id),
        projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
        eventType,
        payload: row.payload,
        redactedPaths: []
      };
    }
    const output = redactEventPayload({ eventName: eventType, payload: row.payload, actor, rawView: false });
    return {
      id: row.id as number | string,
      ts: row.ts as Date,
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      specId: row.spec_id === null || row.spec_id === undefined ? null : String(row.spec_id),
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
      eventType,
      payload: output.payload,
      redactedPaths: output.redactedPaths
    };
  });
  return { events };
}

// ---------------------------------------------------------------------------
// `tanren.read_costs`
// ---------------------------------------------------------------------------

export interface TanrenReadCostsArgs {
  runId?: string;
  projectId?: string;
  since?: string;
}

export async function tanrenReadCosts(
  deps: ToolDeps,
  args: TanrenReadCostsArgs,
  actor: ActorContext
): Promise<{ costs: ReadonlyArray<Record<string, unknown>>; totalUsd: string }> {
  if (args.runId === undefined && args.projectId === undefined) {
    throw new ToolAccessDeniedError("read_costs requires runId or projectId");
  }
  let projectId = args.projectId;
  if (args.runId !== undefined) {
    const access = await assertRunAccess(deps.pool, args.runId, actor);
    projectId = projectId ?? access.projectId;
  } else if (projectId !== undefined) {
    await assertProjectAccess(deps.pool, projectId, actor);
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (args.runId !== undefined) {
    params.push(args.runId);
    clauses.push(`run_id = $${params.length}`);
  } else if (projectId !== undefined) {
    params.push(projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (args.since !== undefined) {
    params.push(args.since);
    clauses.push(`recorded_at >= $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await deps.pool.query(
    `SELECT id, task_id, run_id, project_id, cli, provider, model,
            input_tokens, cached_input_tokens, cache_creation_tokens,
            output_tokens, reasoning_output_tokens, total_tokens, cost_usd,
            billing_mode, cost_basis, recorded_at
     FROM cost_records
     ${where}
     ORDER BY recorded_at ASC, id ASC`,
    params
  );
  // cost_usd is best-effort and may be NULL; null rows contribute nothing to
  // the dollar total but are still returned with their token breakdown.
  const totalUsd = result.rows.reduce<number>((sum, row) => {
    const value = (row as { cost_usd: string | null }).cost_usd;
    return value === null || value === undefined ? sum : sum + Number(value);
  }, 0);
  return {
    costs: result.rows as ReadonlyArray<Record<string, unknown>>,
    totalUsd: totalUsd.toFixed(6)
  };
}

// ---------------------------------------------------------------------------
// `tanren.read_behaviors` / `tanren.read_milestones`
// ---------------------------------------------------------------------------

export async function tanrenReadBehaviors(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext
): Promise<{ behaviors: ReadonlyArray<Record<string, unknown>> }> {
  await assertProjectAccess(deps.pool, args.projectId, actor);
  // Behaviors are persona-scoped; we list every persona reachable from the
  // project's org and union the behaviors. Matches what the dashboard
  // (P2B-0003) needs: "all behaviors my project can reference".
  const personaResult = await deps.pool.query<{ id: string }>(
    `SELECT id FROM personas WHERE org_id = (
       SELECT org_id FROM projects WHERE project_id = $1
     ) AND (scope = 'org' OR project_id = $1)`,
    [args.projectId]
  );
  const personaIds = personaResult.rows.map((row) => row.id);
  if (personaIds.length === 0) return { behaviors: [] };
  const result = await deps.pool.query(
    `SELECT id, persona_id, title, given, "when", "then", description, metadata, created_at, updated_at
     FROM behaviors
     WHERE persona_id = ANY($1::text[])
     ORDER BY title`,
    [personaIds]
  );
  return { behaviors: result.rows as ReadonlyArray<Record<string, unknown>> };
}

export async function tanrenReadMilestones(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext
): Promise<{ milestones: ReadonlyArray<Record<string, unknown>> }> {
  const rows = await MilestoneStore.listForProject(deps.pool, args.projectId, actor);
  return { milestones: rows as unknown as ReadonlyArray<Record<string, unknown>> };
}

// ---------------------------------------------------------------------------
// `tanren.read_insights` — wraps the P2A-0020 compute-on-read dispatcher.
// The dashboard's ⌘K palette and the Forge narration generator both call
// this tool, so a single shared loader keeps the cache hit-rate consistent.
// ---------------------------------------------------------------------------

import { loadInsightsForProject } from "../../insights/index.js";

export async function tanrenReadInsights(
  deps: ToolDeps,
  args: { projectId: string },
  actor: ActorContext
): Promise<{ insights: ReadonlyArray<Record<string, unknown>> }> {
  await assertProjectAccess(deps.pool, args.projectId, actor);
  const insights = await loadInsightsForProject(deps.pool, { projectId: args.projectId });
  return { insights: insights as unknown as ReadonlyArray<Record<string, unknown>> };
}
