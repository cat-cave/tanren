// P2A-0019: Forge HTTP routes. The dashboard hits these from the project
// view and run-detail page. Tool invocations land at `/forge/tools/:toolId`
// and route to the typed implementations in `engine/forge/tools/`.
//
// All routes require auth + org scope. The route bodies are intentionally
// thin — every check lives in the store/tool layer so the HTTP shape is
// uniform.

import { runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { ForgeToolCall } from "../../engine/answerers/schemas/forge.js";
import {
  ForgeThreadAccessDeniedError,
  ForgeThreadStore,
  ForgeTurnStore,
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
  WriteToolAccessDeniedError,
} from "../../engine/forge/index.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";
import { generateProjectViewTurn, generateRunDetailTurn } from "./narration.js";

interface ForgeRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
}

const ThreadCreateBody = z.object({
  scope: z.enum(["org", "project", "run"]),
  projectId: z.string().min(1).nullable().optional(),
  runId: z.string().min(1).nullable().optional(),
  title: z.string().nullable().optional(),
});

const GenerateProjectViewBody = z.object({
  projectId: z.string().min(1),
  audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]).optional(),
  budgetUsdPerWeek: z.number().nonnegative().optional(),
});

const GenerateRunDetailBody = z.object({
  runId: z.string().min(1),
  audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]).optional(),
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
    const parsed = ThreadCreateBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_thread", issues: parsed.error.issues }, 400);
    }
    try {
      // RLS R2 cohort-4 (forge): run the forge_threads write inside an
      // org-scoped txn (org = path org, validated above). Inert in R1; the
      // store resolves the same ambient client. Behavior-identical to the pool.
      const thread = await runWithOrgScope(options.pool, orgId, (client) =>
        ForgeThreadStore.create(
          client,
          {
            orgId,
            scope: parsed.data.scope,
            projectId: parsed.data.projectId ?? null,
            runId: parsed.data.runId ?? null,
            title: parsed.data.title ?? null,
          },
          actor,
        ),
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
      // RLS R2 cohort-4 (forge): thread + turns reads in one org-scoped txn.
      const bundle = await runWithOrgScope(options.pool, orgId, async (client) => {
        const thread = await ForgeThreadStore.get(client, c.req.param("threadId"), actor);
        if (thread === undefined) return;
        const turns = await ForgeTurnStore.list(client, { threadId: thread.id, limit: 50 }, actor);
        return { thread, turns };
      });
      if (bundle === undefined) {
        return c.json({ error: "forge_thread_not_found" }, 404);
      }
      return c.json(bundle);
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
      // RLS R2 cohort-4 (forge): forge_turns read on the org-scoped client.
      const turns = await runWithOrgScope(options.pool, orgId, (client) =>
        ForgeTurnStore.list(
          client,
          {
            threadId: c.req.param("threadId"),
            limit: Number.isFinite(limit) ? Math.min(limit, 200) : 100,
            sinceIndex: sinceIndex === undefined ? undefined : Number(sinceIndex),
          },
          actor,
        ),
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
    const parsed = GenerateProjectViewBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_generate", issues: parsed.error.issues }, 400);
    }
    try {
      // RLS R2 cohort-4 (forge): the narration generator reads project/run/cost
      // context AND appends a forge_turn — run the whole thing in one org-scoped
      // txn so every read/write carries org context.
      const turn = await runWithOrgScope(options.pool, orgId, (client) =>
        generateProjectViewTurn({
          client,
          threadId: c.req.param("threadId"),
          projectId: parsed.data.projectId,
          audience: parsed.data.audience ?? "project:member",
          budgetUsdPerWeek: parsed.data.budgetUsdPerWeek,
          actor,
        }),
      );
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
    const parsed = GenerateRunDetailBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_generate", issues: parsed.error.issues }, 400);
    }
    try {
      // RLS R2 cohort-4 (forge): run-detail narration read context + forge_turn
      // append in one org-scoped txn.
      const turn = await runWithOrgScope(options.pool, orgId, (client) =>
        generateRunDetailTurn({
          client,
          threadId: c.req.param("threadId"),
          runId: parsed.data.runId,
          audience: parsed.data.audience ?? "project:member",
          actor,
        }),
      );
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
    const parsed = ToolInvocationBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_tool_call", issues: parsed.error.issues }, 400);
    }
    try {
      // RLS R3a: open an org scope (org = path org, validated above) around the
      // whole tool dispatch so the read/write tools' tenant-table queries carry
      // org context via `resolveQueryClient`/`resolveWritableClient`. Write tools
      // that open their own org-scoped txn (`tanren.create_spec` /
      // `tanren.trigger_run` / `tanren.rerun_task`) keep doing so — they read
      // already-committed rows, so the nested scope is safe. Inert in R1.
      const result = await runWithOrgScope(options.pool, orgId, () =>
        dispatchTool({
          pool: options.pool,
          secrets: options.secrets,
          githubHttp: options.githubHttp,
          actor,
          call: parsed.data,
        }),
      );
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

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
