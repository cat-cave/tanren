// P2A-0019: Forge HTTP routes. The dashboard hits these from the project
// view and run-detail page. Tool invocations land at `/forge/tools/:toolId`
// and route to the typed implementations in `engine/forge/tools/`.
//
// All routes require auth + org scope. The route bodies are intentionally
// thin — every check lives in the store/tool layer so the HTTP shape is
// uniform.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { ForgeToolCall } from "../../engine/answerers/schemas/forge.js";
import {
  ForgeThreadAccessDeniedError,
  ForgeThreadStore,
  ForgeTurnStore,
  generateProjectViewNarration,
  generateRunDetailNarration,
  type NarrationInsight,
  repoGrep,
  repoReadFile,
  repoReadIssue,
  tanrenAcknowledgeInsight,
  tanrenCreateSpec,
  tanrenReadBehaviors,
  tanrenReadCosts,
  tanrenReadEvents,
  tanrenReadInsights,
  tanrenReadMilestones,
  tanrenReadRun,
  tanrenReadSpec,
  tanrenRerunTask,
  tanrenTriggerRun,
  ToolAccessDeniedError,
  WriteToolAccessDeniedError
} from "../../engine/forge/index.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { loadInsightsForProject } from "../../engine/insights/index.js";
import type { Insight, InsightAction } from "../../engine/insights/index.js";
import { ForgeInsightKind } from "../../engine/answerers/schemas/forge.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface ForgeRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
}

const ThreadCreateBody = z.object({
  scope: z.enum(["org", "project", "run"]),
  projectId: z.string().min(1).nullable().optional(),
  runId: z.string().min(1).nullable().optional(),
  title: z.string().nullable().optional()
});

const GenerateProjectViewBody = z.object({
  projectId: z.string().min(1),
  audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]).optional(),
  budgetUsdPerWeek: z.number().nonnegative().optional()
});

const GenerateRunDetailBody = z.object({
  runId: z.string().min(1),
  audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]).optional()
});

const ToolInvocationBody = ForgeToolCall;

export function createForgeRoutes(options: ForgeRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/forge/threads", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ThreadCreateBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_thread", issues: parsed.error.issues }, 400);
    }
    try {
      const thread = await ForgeThreadStore.create(
        options.pool,
        {
          orgId,
          scope: parsed.data.scope,
          projectId: parsed.data.projectId ?? null,
          runId: parsed.data.runId ?? null,
          title: parsed.data.title ?? null
        },
        actor
      );
      return c.json(thread, 201);
    } catch (error) {
      return c.json({ error: "forge_thread_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/forge/threads/:threadId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const thread = await ForgeThreadStore.get(options.pool, c.req.param("threadId"), actor);
      if (thread === undefined) {
        return c.json({ error: "forge_thread_not_found" }, 404);
      }
      const turns = await ForgeTurnStore.list(options.pool, { threadId: thread.id, limit: 50 }, actor);
      return c.json({ thread, turns });
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_thread_read_failed", message: messageOf(error) }, 500);
    }
  });

  app.get("/:orgId/forge/threads/:threadId/turns", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const limit = Number(c.req.query("limit") ?? "100");
    const sinceIndex = c.req.query("sinceIndex");
    try {
      const turns = await ForgeTurnStore.list(
        options.pool,
        {
          threadId: c.req.param("threadId"),
          limit: Number.isFinite(limit) ? Math.min(limit, 200) : 100,
          sinceIndex: sinceIndex === undefined ? undefined : Number(sinceIndex)
        },
        actor
      );
      return c.json({ turns });
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_turns_read_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/forge/threads/:threadId/turns/generate-project-view", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = GenerateProjectViewBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_generate", issues: parsed.error.issues }, 400);
    }
    try {
      const turn = await generateProjectViewTurn({
        pool: options.pool,
        threadId: c.req.param("threadId"),
        projectId: parsed.data.projectId,
        audience: parsed.data.audience ?? "project:member",
        budgetUsdPerWeek: parsed.data.budgetUsdPerWeek,
        actor
      });
      return c.json(turn, 201);
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_narration_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/forge/threads/:threadId/turns/generate-run-detail", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = GenerateRunDetailBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_generate", issues: parsed.error.issues }, 400);
    }
    try {
      const turn = await generateRunDetailTurn({
        pool: options.pool,
        threadId: c.req.param("threadId"),
        runId: parsed.data.runId,
        audience: parsed.data.audience ?? "project:member",
        actor
      });
      return c.json(turn, 201);
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_narration_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/forge/tools", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ToolInvocationBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_tool_call", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await dispatchTool({
        pool: options.pool,
        secrets: options.secrets,
        githubHttp: options.githubHttp,
        actor,
        call: parsed.data
      });
      return c.json({ tool: parsed.data.tool, result });
    } catch (error) {
      if (error instanceof ToolAccessDeniedError || error instanceof WriteToolAccessDeniedError) {
        return c.json({ error: "tool_access_denied", message: error.message }, 403);
      }
      return c.json({ error: "tool_invocation_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tool dispatch — the discriminated union from P2A-0008 keys into the
// typed implementations. Adding a new tool is: extend `ForgeToolCall`,
// implement the function, add a case here.
// ---------------------------------------------------------------------------

interface DispatchInput {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  actor: ActorContext;
  call: z.infer<typeof ForgeToolCall>;
}

async function dispatchTool(input: DispatchInput): Promise<unknown> {
  const { pool, secrets, githubHttp, actor, call } = input;
  switch (call.tool) {
    case "tanren.read_spec":
      return tanrenReadSpec({ pool }, call.args, actor);
    case "tanren.read_run":
      return tanrenReadRun({ pool }, call.args, actor);
    case "tanren.read_events":
      return tanrenReadEvents({ pool }, call.args, actor);
    case "tanren.read_costs":
      return tanrenReadCosts({ pool }, call.args, actor);
    case "tanren.read_behaviors":
      return tanrenReadBehaviors({ pool }, call.args, actor);
    case "tanren.read_milestones":
      return tanrenReadMilestones({ pool }, call.args, actor);
    case "tanren.read_insights":
      return tanrenReadInsights({ pool }, call.args, actor);
    case "repo.read_file":
      return repoReadFile({ pool, secrets, githubHttp }, call.args, actor);
    case "repo.grep":
      return repoGrep({ pool, secrets, githubHttp }, call.args, actor);
    case "repo.read_issue":
      return repoReadIssue({ pool, secrets, githubHttp }, call.args, actor);
    case "tanren.create_spec":
      return tanrenCreateSpec({ pool }, call.args, actor);
    case "tanren.trigger_run":
      return tanrenTriggerRun({ pool }, call.args, actor);
    case "tanren.rerun_task":
      return tanrenRerunTask({ pool }, call.args, actor);
    case "tanren.acknowledge_insight":
      return tanrenAcknowledgeInsight({ pool }, call.args, actor);
  }
}

// ---------------------------------------------------------------------------
// Generators — load typed context from existing stores and pass it to the
// templated narration in `engine/forge/narration/v0.ts`.
// ---------------------------------------------------------------------------

interface GenerateProjectViewArgs {
  pool: pg.Pool;
  threadId: string;
  projectId: string;
  audience: "project:member" | "project:admin" | "org:admin" | "platform:admin";
  budgetUsdPerWeek?: number;
  actor: ActorContext;
}

async function generateProjectViewTurn(args: GenerateProjectViewArgs) {
  // Verify the thread exists and the actor can reach it. We do not need the
  // thread row beyond that — the narration generator reads project context.
  const thread = await ForgeThreadStore.get(args.pool, args.threadId, args.actor);
  if (thread === undefined) {
    throw new Error(`forge thread not found: ${args.threadId}`);
  }
  const projectResult = await args.pool.query<{ name: string }>(
    "SELECT name FROM projects WHERE project_id = $1",
    [args.projectId]
  );
  const projectName = projectResult.rows[0]?.name ?? args.projectId;

  const recentRuns = await args.pool.query<{
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
    [args.projectId]
  );

  const pendingReviews = recentRuns.rows.filter(
    (row) => row.outcome !== null && row.outcome !== "merged" && row.pr_url !== null
  );

  const costResult = await args.pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
     FROM cost_records
     WHERE project_id = $1 AND recorded_at >= NOW() - INTERVAL '7 days'`,
    [args.projectId]
  );
  const weekToDateCostUsd = Number(costResult.rows[0]?.total ?? "0");

  const answer = generateProjectViewNarration({
    project: { projectId: args.projectId, name: projectName },
    recentRuns: recentRuns.rows.map((row) => ({
      runId: row.run_id,
      specId: row.spec_id,
      status: row.status,
      outcome: row.outcome,
      prUrl: row.pr_url,
      startedAt: row.started_at,
      endedAt: row.ended_at
    })),
    pendingReviews: pendingReviews.map((row) => ({
      runId: row.run_id,
      specId: row.spec_id,
      status: row.status,
      outcome: row.outcome,
      prUrl: row.pr_url,
      startedAt: row.started_at,
      endedAt: row.ended_at
    })),
    weekToDateCostUsd,
    budgetUsdPerWeek: args.budgetUsdPerWeek,
    insights: await loadNarrationInsights(args.pool, args.projectId),
    actor: args.actor
  });

  return ForgeTurnStore.append(
    args.pool,
    {
      threadId: args.threadId,
      source: { kind: "operator", userId: args.actor.userId },
      audience: args.audience,
      authorKind: "forge_template",
      render: answer
    },
    args.actor
  );
}

interface GenerateRunDetailArgs {
  pool: pg.Pool;
  threadId: string;
  runId: string;
  audience: "project:member" | "project:admin" | "org:admin" | "platform:admin";
  actor: ActorContext;
}

async function generateRunDetailTurn(args: GenerateRunDetailArgs) {
  const thread = await ForgeThreadStore.get(args.pool, args.threadId, args.actor);
  if (thread === undefined) {
    throw new Error(`forge thread not found: ${args.threadId}`);
  }
  const runResult = await args.pool.query<{
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
    [args.runId]
  );
  const runRow = runResult.rows[0];
  if (runRow === undefined) {
    throw new Error(`run not found: ${args.runId}`);
  }
  const taskResult = await args.pool.query<{ count: string; failed: string }>(
    `SELECT COUNT(*)::text AS count,
            COUNT(*) FILTER (WHERE outcome = 'failed')::text AS failed
     FROM tasks WHERE run_id = $1`,
    [args.runId]
  );
  const taskCount = Number(taskResult.rows[0]?.count ?? "0");
  const failedTaskCount = Number(taskResult.rows[0]?.failed ?? "0");
  const costResult = await args.pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(cost_usd::numeric), 0)::text AS total
     FROM cost_records WHERE run_id = $1`,
    [args.runId]
  );
  const projectName =
    (await args.pool.query<{ name: string }>("SELECT name FROM projects WHERE project_id = $1", [runRow.project_id]))
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
      endedAt: runRow.ended_at
    },
    taskCount,
    failedTaskCount,
    costUsd: Number(costResult.rows[0]?.total ?? "0"),
    insights: await loadNarrationInsights(args.pool, runRow.project_id),
    actor: args.actor
  });
  return ForgeTurnStore.append(
    args.pool,
    {
      threadId: args.threadId,
      source: { kind: "operator", userId: args.actor.userId },
      audience: args.audience,
      authorKind: "forge_template",
      render: answer
    },
    args.actor
  );
}

// Convert P2A-0020 insights into the NarrationInsight shape expected by the
// v0 narration generator. Actions whose `toolCall` doesn't parse as a known
// ForgeToolCall (e.g. a future variant added before the schema is updated)
// are dropped so the narration stays renderable.
async function loadNarrationInsights(
  pool: pg.Pool,
  projectId: string
): Promise<NarrationInsight[]> {
  const insights = await loadInsightsForProject(pool, { projectId });
  return insights.map((insight) => toNarrationInsight(insight)).filter(
    (entry): entry is NarrationInsight => entry !== undefined
  );
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
    actions
  };
}

function normalizeInsightAction(
  action: InsightAction
): { label: string; toolCall: z.infer<typeof ForgeToolCall> } | undefined {
  const parsed = ForgeToolCall.safeParse(action.toolCall);
  if (!parsed.success) return undefined;
  return { label: action.label, toolCall: parsed.data };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
