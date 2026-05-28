// P2A-0014: Run-detail read API surface — list, snapshot, events, costs,
// Forge bundle, SSE stream, and project activity feed. Every handler is
// scoped through `assertProjectAccess` (P2A-0019 helper) so the same authz
// gate the Forge tool surface uses governs the public API. Event/cost
// payloads pass through the P2A-0009 redaction serializer with the actor's
// scope; the dashboard opts into raw values via `?raw=true` or the
// `X-View-Raw` header and the audit emitter handles the trail.
//
// Routes are mounted under `/orgs` (org+project path style) so the dashboard
// can address every surface with the same prefix:
//   /orgs/:orgId/projects/:projectId/runs                        — list
//   /orgs/:orgId/projects/:projectId/runs/:runId                 — detail
//   /orgs/:orgId/projects/:projectId/runs/:runId/events          — paginated
//   /orgs/:orgId/projects/:projectId/runs/:runId/costs           — paginated
//   /orgs/:orgId/projects/:projectId/runs/:runId/forge           — thread + turns
//   /orgs/:orgId/projects/:projectId/runs/:runId/stream          — SSE
//   /orgs/:orgId/projects/:projectId/feed                        — activity feed

import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, assertRunAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { ForgeThreadStore, ForgeTurnStore } from "../../engine/forge/index.js";
import { loadInsightsForProject } from "../../engine/insights/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";
import {
  type RunDetail,
  type RunListItem,
  type RunSpecSummary,
  RECENT_EVENT_CAP
} from "./contract.js";
import {
  fetchCostsPage,
  fetchEventsPage,
  fetchFeedPage,
  fetchRunCostsForSnapshot,
  fetchRunEventsForSnapshot,
  fetchRunInsights,
  fetchRunListItems,
  fetchRunSummary,
  fetchRunSpecSummary,
  fetchRunTasks
} from "./list.js";
import { handleSseStream } from "./sse.js";
import { parseRawViewOptIn } from "./redaction.js";

interface RunRoutesOptions {
  pool: pg.Pool;
  // Override the SSE polling cadence in tests; defaults to 1s per spec v0.
  sseIntervalMs?: number;
  // Optional clock override for deterministic SSE heartbeats in tests.
  sseNow?: () => Date;
}

export function createRunRoutes(options: RunRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const items = await fetchRunListItems(options.pool, {
      projectId,
      status: c.req.query("status"),
      specId: c.req.query("specId")
    });
    return c.json({ items });
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs/:runId
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs/:runId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const runId = c.req.param("runId");
    const projectId = c.req.param("projectId");

    const summary = await fetchRunSummary(options.pool, runId);
    if (summary === undefined) {
      return c.json({ error: "run_not_found" }, 404);
    }
    if (summary.projectId !== projectId) {
      return c.json({ error: "run_not_found" }, 404);
    }
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const rawView = parseRawViewOptIn(c);
    const [spec, tasks, recentEvents, costs, insights, forgeThread] = await Promise.all([
      fetchRunSpecSummary(options.pool, summary.specId),
      fetchRunTasks(options.pool, runId),
      fetchRunEventsForSnapshot(options.pool, { runId, limit: RECENT_EVENT_CAP, actor, rawView }),
      fetchRunCostsForSnapshot(options.pool, runId),
      fetchRunInsights(options.pool, summary.projectId, summary.specId, runId),
      fetchForgeBundle(options.pool, { orgId, projectId, runId, actor })
    ]);

    const detail: RunDetail = {
      run: summary,
      spec: spec ?? fallbackSpec(summary.specId),
      tasks,
      recentEvents,
      costs,
      insights,
      forgeThread
    };
    return c.json(detail);
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs/:runId/events  (paginated)
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs/:runId/events", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const runId = c.req.param("runId");
    const projectId = c.req.param("projectId");
    try {
      const access = await assertRunAccess(options.pool, runId, actor);
      if (access.projectId !== projectId) {
        return c.json({ error: "run_not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "run_not_found" }, 404);
      }
      throw error;
    }

    try {
      const page = await fetchEventsPage(options.pool, {
        runId,
        cursor: c.req.query("cursor"),
        pageSize: c.req.query("pageSize"),
        actor,
        rawView: parseRawViewOptIn(c)
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs/:runId/costs  (paginated)
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs/:runId/costs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const runId = c.req.param("runId");
    const projectId = c.req.param("projectId");
    try {
      const access = await assertRunAccess(options.pool, runId, actor);
      if (access.projectId !== projectId) {
        return c.json({ error: "run_not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "run_not_found" }, 404);
      }
      throw error;
    }
    try {
      const page = await fetchCostsPage(options.pool, {
        runId,
        cursor: c.req.query("cursor"),
        pageSize: c.req.query("pageSize")
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs/:runId/forge
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs/:runId/forge", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const bundle = await fetchForgeBundle(options.pool, { orgId, projectId, runId, actor });
    if (bundle === null) {
      return c.json({ thread: null, turns: [] });
    }
    return c.json(bundle);
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/runs/:runId/stream  (SSE)
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/runs/:runId/stream", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const runId = c.req.param("runId");
    const projectId = c.req.param("projectId");
    try {
      const access = await assertRunAccess(options.pool, runId, actor);
      if (access.projectId !== projectId) {
        return c.json({ error: "run_not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "run_not_found" }, 404);
      }
      throw error;
    }
    return handleSseStream(c, {
      pool: options.pool,
      runId,
      projectId,
      actor,
      rawView: parseRawViewOptIn(c),
      intervalMs: options.sseIntervalMs ?? 1_000,
      now: options.sseNow
    });
  });

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects/:projectId/feed
  // -------------------------------------------------------------------------
  app.get("/:orgId/projects/:projectId/feed", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;
    try {
      const page = await fetchFeedPage(options.pool, {
        projectId,
        cursor: c.req.query("cursor"),
        pageSize: c.req.query("pageSize"),
        actor,
        rawView: parseRawViewOptIn(c)
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Shared access gate. ToolAccessDeniedError is the project-access miss; we
// fold it into a 403 with the same shape every other route uses. Returns
// undefined on success or a denial Response that the caller can short-
// circuit on.
// ---------------------------------------------------------------------------

async function gateProjectAccess(
  pool: pg.Pool,
  projectId: string,
  actor: ActorContext,
  c: Context
): Promise<Response | undefined> {
  try {
    await assertProjectAccess(pool, projectId, actor);
    return undefined;
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) {
      return c.json({ error: "project_access_denied", message: error.message }, 403);
    }
    throw error;
  }
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

// ---------------------------------------------------------------------------
// Forge bundle: pick the most recent run-scoped thread (if any) and return
// up to 50 turns. Returns null when no thread exists, which the dashboard
// renders as "no Forge narration yet".
// ---------------------------------------------------------------------------

interface ForgeBundleArgs {
  orgId: string;
  projectId: string;
  runId: string;
  actor: ActorContext;
}

async function fetchForgeBundle(
  pool: pg.Pool,
  args: ForgeBundleArgs
): Promise<RunDetail["forgeThread"]> {
  try {
    const threads = await ForgeThreadStore.listForRun(
      pool,
      { orgId: args.orgId, projectId: args.projectId, runId: args.runId },
      args.actor
    );
    const head = threads[0];
    if (head === undefined) return null;
    const turns = await ForgeTurnStore.list(pool, { threadId: head.id, limit: 50 }, args.actor);
    return { threadId: head.id, recentTurns: turns };
  } catch {
    // ForgeThreadStore throws when the actor cannot reach the thread's
    // scope. Treat that as "no bundle" so the rest of the run detail still
    // renders rather than returning a 403 for the whole snapshot.
    return null;
  }
}

function fallbackSpec(specId: string): RunSpecSummary {
  // Legacy fixture runs may reference a spec_id that no longer has a row in
  // the specs table. The contract requires a spec object on RunDetail, so we
  // return a degraded-but-typed shape rather than 500ing. The dashboard can
  // render "spec missing".
  return {
    specId,
    title: "(spec not found)",
    description: "",
    behaviorIds: [],
    milestoneId: null
  };
}

// Re-export so 2B can import insight typing from a single point.
export type { Insight } from "../../engine/insights/index.js";
// Re-export contract types for downstream test imports.
export type { RunListItem, RunDetail };
// Plus the bundle insight loader helper (rarely needed but useful for SSE
// extension paths). The actual call lives in list.ts.
export { loadInsightsForProject };
