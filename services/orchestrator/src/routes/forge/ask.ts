// P3-0010: thick-Forge conversation HTTP route.
//
// `POST /:orgId/forge/threads/:threadId/ask` runs one operator question
// through the LLM-backed conversation engine (engine/forge/conversation) and
// returns the persisted operator + forge turns. The dashboard's ⌘K chat morph
// calls this (cookie-forwarded) and renders the forge turn's ForgeAnswer as a
// chat bubble + follow-up chips + auto-navigate cards.
//
// Split out of routes/forge/index.ts (which is at the 500-line cap) and mounted
// alongside it on the same `/orgs` base — additive, no edits to the existing
// route file.
//
// The answerer is injectable (`answererFactory`): production wires a provider
// Answerer (P3-0012); when none is configured the route falls back to a
// deterministic grounded answerer so the endpoint always responds without
// provider infra. Tests inject a fake answerer.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  askForge,
  ForgeThreadAccessDeniedError,
  repoGrep,
  repoReadFile,
  repoReadIssue,
  tanrenReadBehaviors,
  tanrenReadCosts,
  tanrenReadEvents,
  tanrenReadInsights,
  tanrenReadMilestones,
  tanrenReadRun,
  tanrenReadSpec,
  ToolAccessDeniedError,
  type ForgeConversationAnswerer,
  type ForgeReadToolCall,
  type ForgeReadToolDispatcher
} from "../../engine/forge/index.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";
import { createDeterministicForgeAnswerer } from "./deterministicAnswerer.js";

export interface ForgeAskRoutesOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // Injectable answerer (P3-0012 provider wrap, or a test fake). Defaults to a
  // deterministic grounded answerer when omitted.
  answererFactory?: () => ForgeConversationAnswerer;
}

const AskBody = z.object({
  question: z.string().min(1).max(4000),
  audience: z.enum(["project:member", "project:admin", "org:admin", "platform:admin"]).optional()
});

export function createForgeAskRoutes(options: ForgeAskRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const answererFactory = options.answererFactory ?? (() => createDeterministicForgeAnswerer());

  app.post("/:orgId/forge/threads/:threadId/ask", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = AskBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_ask", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await askForge(
        {
          client: options.pool,
          answerer: answererFactory(),
          dispatchReadTool: buildReadToolDispatcher(options)
        },
        {
          threadId: c.req.param("threadId"),
          question: parsed.data.question,
          audience: parsed.data.audience ?? "project:member",
          actor
        }
      );
      return c.json(
        {
          operatorTurn: result.operatorTurn,
          forgeTurn: result.forgeTurn,
          toolsUsed: result.toolResults.map((entry) => entry.call.tool)
        },
        201
      );
    } catch (error) {
      if (error instanceof ForgeThreadAccessDeniedError) {
        return c.json({ error: "forge_thread_access_denied" }, 403);
      }
      return c.json({ error: "forge_ask_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

// Dispatches the READ family through the typed tool layer (authz + redaction
// live there). Write tools never reach here — the engine filters them out — so
// this switch is exhaustive over the read variants only.
export function buildReadToolDispatcher(options: ForgeAskRoutesOptions): ForgeReadToolDispatcher {
  const { pool, secrets, githubHttp } = options;
  return async (call: ForgeReadToolCall, actor: ActorContext): Promise<unknown> => {
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
    }
  };
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

export { ToolAccessDeniedError };
