// HTTP route for DORA-like delivery metrics.
//
// `GET /orgs/:orgId/projects/:projectId/dora?windowDays=30` returns the four
// reported (not targeted) DORA metrics derived from existing run/event data.
// Authz mirrors the workflow-insights route: org membership + project access
// through the same `assertProjectAccess` gate the Forge tool layer uses.

import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { computeDoraMetrics } from "../../engine/insights/dora/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface DoraRoutesOptions {
  pool: pg.Pool;
}

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;

/** Parse + clamp the `windowDays` query param to a sane range. */
function parseWindowDays(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, parsed));
}

export function createDoraRoutes(options: DoraRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/dora", async (c) => {
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
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    try {
      const metrics = await computeDoraMetrics(options.pool, { projectId, windowDays });
      return c.json({ metrics });
    } catch (error) {
      return c.json(
        {
          error: "dora_read_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
