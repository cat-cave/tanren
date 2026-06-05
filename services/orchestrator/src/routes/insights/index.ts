// HTTP routes for workflow insights.
//
// `GET /orgs/:orgId/projects/:projectId/insights` returns the read-through
// cache for every supported kind. The handler enforces the same project
// access gate the Forge tool layer uses (`assertProjectAccess`) so the
// dashboard surface and the Forge narration generator both see the same
// authz rules.
//
// `POST /orgs/:orgId/projects/:projectId/insights/:insightId/acknowledge`
// records an operator ack so the cache row drops out of the next read.

import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { acknowledgeInsight, loadInsightsForProject } from "../../engine/insights/index.js";
import { surfaceActiveQuarantines } from "../../engine/insights/ciFlakySurface.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface InsightRoutesOptions {
  pool: pg.Pool;
}

export function createInsightRoutes(options: InsightRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/insights", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    try {
      await assertProjectAccess(options.pool, projectId, actor);
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      throw error;
    }
    try {
      // CI-intelligence PR2: the GET is now READ-ONLY for flaky. Flaky DETECTION +
      // quarantine WRITES moved off this GET onto the worker loop (CiInsightsLoop) —
      // the GET no longer triggers a write. We still SURFACE every active quarantine
      // as a `ci_flaky` insight via the read-only `surfaceActiveQuarantines` so the
      // operator keeps seeing them; the other (pure) insight kinds load as before.
      const [insights, quarantineInsights] = await Promise.all([
        loadInsightsForProject(options.pool, { projectId }),
        surfaceActiveQuarantines(options.pool, projectId),
      ]);
      return c.json({ insights: [...insights, ...quarantineInsights] });
    } catch (error) {
      return c.json(
        {
          error: "insights_read_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });

  app.post("/:orgId/projects/:projectId/insights/:insightId/acknowledge", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    try {
      await assertProjectAccess(options.pool, projectId, actor);
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      throw error;
    }
    const acked = await acknowledgeInsight(options.pool, c.req.param("insightId"), actor.userId);
    if (!acked) {
      return c.json({ error: "insight_not_found_or_already_acked" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
