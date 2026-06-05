// (autonomy-engine.md §2d) read routes for the two pure
// CI/queue read-models:
//
//   GET /orgs/:orgId/projects/:projectId/ci-analytics?windowDays=30
//        → per-project CI pass-rate, timing, slowest/least-reliable checks,
//          retry rate.
//   GET /orgs/:orgId/projects/:projectId/queue-stats?windowDays=30
//        → queue depth over time, time-in-queue, batch pass-rate, bisect /
//          culprit counts, stack depth.
//
// Authz mirrors the DORA + workflow-insights routes exactly: org membership +
// project access through the same `assertProjectAccess` gate the Forge tool
// layer uses. Both handlers are read-only — no write path.

import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { computeCiAnalytics, computeQueueStats } from "../../engine/insights/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface CiInsightRoutesOptions {
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

export function createCiInsightRoutes(options: CiInsightRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/ci-analytics", async (c) => {
    const gate = await guard(options.pool, c);
    if (gate.kind === "error") return gate.response;
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    try {
      const analytics = await computeCiAnalytics(options.pool, { projectId: gate.projectId, windowDays });
      return c.json({ analytics });
    } catch (error) {
      return c.json({ error: "ci_analytics_read_failed", message: messageOf(error) }, 500);
    }
  });

  app.get("/:orgId/projects/:projectId/queue-stats", async (c) => {
    const gate = await guard(options.pool, c);
    if (gate.kind === "error") return gate.response;
    const windowDays = parseWindowDays(c.req.query("windowDays"));
    try {
      const stats = await computeQueueStats(options.pool, { projectId: gate.projectId, windowDays });
      return c.json({ stats });
    } catch (error) {
      return c.json({ error: "queue_stats_read_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

type Guarded = { kind: "ok"; projectId: string } | { kind: "error"; response: Response };

/** Shared org-membership + project-access gate for both read routes. */
async function guard(pool: pg.Pool, c: Context<ActorContextEnv>): Promise<Guarded> {
  const actor = requireActor(c);
  const orgId = c.req.param("orgId") ?? "";
  if (!actorCanAccessOrg(actor, orgId)) {
    return { kind: "error", response: c.json({ error: "org_access_denied" }, 403) };
  }
  const projectId = c.req.param("projectId") ?? "";
  try {
    await assertProjectAccess(pool, projectId, actor);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return { kind: "error", response: c.json({ error: "project_access_denied", message: error.message }, 403) };
    }
    throw error;
  }
  return { kind: "ok", projectId };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
