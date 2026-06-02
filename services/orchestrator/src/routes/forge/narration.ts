// P2A-0019 narration generators, split out of routes/forge/index.ts (which is
// at the 500-line cap) so the route file stays under it after the RLS R2
// cohort-4 org-scoping wrapping. The route handlers call these inside a
// `runWithOrgScope` txn; the generators load typed context from existing
// stores + tenant tables on the org-scoped `client` and append a forge_turn,
// then template the narration in `engine/forge/narration/v0.ts`.
//
// RLS R2 cohort-4: `client` is the ambient org-scoped client — it carries the
// forge_turn append + the project/run/cost context reads.
//
// RLS R3a: the insights-cache read (`loadNarrationInsights` → engine/insights)
// now runs on the same org-scoped `client`, so the insights compute reads
// (runs/events/specs/tasks/cost_records) AND the workflow_insights cache
// read/write carry org context too. The generators no longer take `pool`.

import type pg from "pg";
import type { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { ForgeInsightKind, ForgeToolCall } from "../../engine/answerers/schemas/forge.js";
import {
  ForgeThreadStore,
  ForgeTurnStore,
  generateProjectViewNarration,
  generateRunDetailNarration,
  type NarrationInsight,
} from "../../engine/forge/index.js";
import { migrateProjectConfig } from "../../engine/config/index.js";
import { loadInsightsForProject } from "../../engine/insights/index.js";
import type { Insight, InsightAction } from "../../engine/insights/index.js";

// The pool or the ambient org-scoped client a narration generator runs on.
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface GenerateProjectViewArgs {
  client: QueryClient;
  threadId: string;
  projectId: string;
  audience: "project:member" | "project:admin" | "org:admin" | "platform:admin";
  budgetUsdPerWeek?: number;
  actor: ActorContext;
}

export async function generateProjectViewTurn(args: GenerateProjectViewArgs) {
  // Verify the thread exists and the actor can reach it. We do not need the
  // thread row beyond that — the narration generator reads project context.
  const thread = await ForgeThreadStore.get(args.client, args.threadId, args.actor);
  if (thread === undefined) {
    throw new Error(`forge thread not found: ${args.threadId}`);
  }
  const projectResult = await args.client.query<{ name: string }>("SELECT name FROM projects WHERE project_id = $1", [
    args.projectId,
  ]);
  const projectName = projectResult.rows[0]?.name ?? args.projectId;

  const recentRuns = await args.client.query<{
    run_id: string;
    spec_id: string;
    status: string;
    outcome: string | null;
    pr_url: string | null;
    started_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT run_id, spec_id, status, outcome, pr_url, started_at, ended_at
     FROM runs WHERE project_id = $1
     ORDER BY started_at DESC LIMIT 20`,
    [args.projectId],
  );

  const pendingReviews = recentRuns.rows.filter(
    (row) => row.outcome !== null && row.outcome !== "merged" && row.pr_url !== null,
  );

  const costResult = await args.client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
     FROM cost_records
     WHERE project_id = $1 AND recorded_at >= NOW() - INTERVAL '7 days'`,
    [args.projectId],
  );
  const weekToDateCostUsd = Number(costResult.rows[0]?.total ?? "0");

  // Unify the narration budget-warning threshold with the SAME governed budget
  // config the DagWalker enforces (autonomy-engine.md §3 proof 6): when the caller
  // does not pass an explicit `budgetUsdPerWeek`, fall back to the project's
  // configured budget ceiling. There is no longer a second parallel budget concept
  // — the warning card and the enforced gate read one config. An explicit
  // `budgetUsdPerWeek` still wins (the operator can preview a what-if threshold).
  const budgetUsdPerWeek = args.budgetUsdPerWeek ?? (await resolveConfiguredBudgetCeiling(args.client, args.projectId));

  const answer = generateProjectViewNarration({
    project: { projectId: args.projectId, name: projectName },
    recentRuns: recentRuns.rows.map((row) => ({
      runId: row.run_id,
      specId: row.spec_id,
      status: row.status,
      outcome: row.outcome,
      prUrl: row.pr_url,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })),
    pendingReviews: pendingReviews.map((row) => ({
      runId: row.run_id,
      specId: row.spec_id,
      status: row.status,
      outcome: row.outcome,
      prUrl: row.pr_url,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    })),
    weekToDateCostUsd,
    budgetUsdPerWeek,
    insights: await loadNarrationInsights(args.client, args.projectId),
    actor: args.actor,
  });

  return ForgeTurnStore.append(
    args.client,
    {
      threadId: args.threadId,
      source: { kind: "operator", userId: args.actor.userId },
      audience: args.audience,
      authorKind: "forge_template",
      render: answer,
    },
    args.actor,
  );
}

/**
 * Resolve the project's CONFIGURED budget ceiling for the narration warning — the
 * SAME `projects.config.budget.ceilingUsd` the DagWalker enforces. Returns
 * `undefined` (no warning threshold) when no budget is configured or the config is
 * unparseable — never throws (the narration must render even on a malformed blob).
 * Read on the ambient org-scoped client.
 */
async function resolveConfiguredBudgetCeiling(client: QueryClient, projectId: string): Promise<number | undefined> {
  const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
    projectId,
  ]);
  try {
    return migrateProjectConfig(result.rows[0]?.config).budget?.ceilingUsd;
  } catch {
    return undefined;
  }
}

export interface GenerateRunDetailArgs {
  client: QueryClient;
  threadId: string;
  runId: string;
  audience: "project:member" | "project:admin" | "org:admin" | "platform:admin";
  actor: ActorContext;
}

export async function generateRunDetailTurn(args: GenerateRunDetailArgs) {
  const thread = await ForgeThreadStore.get(args.client, args.threadId, args.actor);
  if (thread === undefined) {
    throw new Error(`forge thread not found: ${args.threadId}`);
  }
  const runResult = await args.client.query<{
    run_id: string;
    spec_id: string;
    project_id: string;
    status: string;
    outcome: string | null;
    pr_url: string | null;
    started_at: Date;
    ended_at: Date | null;
  }>(
    `SELECT run_id, spec_id, project_id, status, outcome, pr_url, started_at, ended_at
     FROM runs WHERE run_id = $1`,
    [args.runId],
  );
  const runRow = runResult.rows[0];
  if (runRow === undefined) {
    throw new Error(`run not found: ${args.runId}`);
  }
  const taskResult = await args.client.query<{ count: string; failed: string }>(
    `SELECT COUNT(*)::text AS count,
            COUNT(*) FILTER (WHERE outcome = 'failed')::text AS failed
     FROM tasks WHERE run_id = $1`,
    [args.runId],
  );
  const taskCount = Number(taskResult.rows[0]?.count ?? "0");
  const failedTaskCount = Number(taskResult.rows[0]?.failed ?? "0");
  const costResult = await args.client.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
     FROM cost_records WHERE run_id = $1`,
    [args.runId],
  );
  const projectName =
    (await args.client.query<{ name: string }>("SELECT name FROM projects WHERE project_id = $1", [runRow.project_id]))
      .rows[0]?.name ?? runRow.project_id;
  const answer = generateRunDetailNarration({
    project: { projectId: runRow.project_id, name: projectName },
    run: {
      runId: runRow.run_id,
      specId: runRow.spec_id,
      status: runRow.status,
      outcome: runRow.outcome,
      prUrl: runRow.pr_url,
      startedAt: runRow.started_at,
      endedAt: runRow.ended_at,
    },
    taskCount,
    failedTaskCount,
    costUsd: Number(costResult.rows[0]?.total ?? "0"),
    insights: await loadNarrationInsights(args.client, runRow.project_id),
    actor: args.actor,
  });
  return ForgeTurnStore.append(
    args.client,
    {
      threadId: args.threadId,
      source: { kind: "operator", userId: args.actor.userId },
      audience: args.audience,
      authorKind: "forge_template",
      render: answer,
    },
    args.actor,
  );
}

// Convert P2A-0020 insights into the NarrationInsight shape expected by the
// v0 narration generator. Actions whose `toolCall` doesn't parse as a known
// ForgeToolCall (e.g. a future variant added before the schema is updated)
// are dropped so the narration stays renderable.
async function loadNarrationInsights(client: QueryClient, projectId: string): Promise<NarrationInsight[]> {
  const insights = await loadInsightsForProject(client, { projectId });
  return insights
    .map((insight) => toNarrationInsight(insight))
    .filter((entry): entry is NarrationInsight => entry !== undefined);
}

function toNarrationInsight(insight: Insight): NarrationInsight | undefined {
  const kindParse = ForgeInsightKind.safeParse(insight.kind);
  if (!kindParse.success) return undefined;
  const actions = insight.actions
    .map((action) => normalizeInsightAction(action))
    .filter((action): action is { label: string; toolCall: z.infer<typeof ForgeToolCall> } => action !== undefined);
  return {
    id: insight.id,
    kind: kindParse.data,
    title: insight.title,
    body: insight.body,
    actions,
  };
}

function normalizeInsightAction(
  action: InsightAction,
): { label: string; toolCall: z.infer<typeof ForgeToolCall> } | undefined {
  const parsed = ForgeToolCall.safeParse(action.toolCall);
  if (!parsed.success) return undefined;
  return { label: action.label, toolCall: parsed.data };
}
