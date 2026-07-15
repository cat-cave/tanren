// Run-detail read API surface — list, snapshot, events, costs,
// Forge bundle, SSE stream, and project activity feed. Every handler is
// scoped through `assertProjectAccess` (helper) so the same authz
// gate the Forge tool surface uses governs the public API. Event/cost
// payloads pass through the redaction serializer with the actor's
// scope; the dashboard opts into raw values via `?raw=true` or the
// `X-View-Raw` header and the audit emitter handles the trail.
//
// Routes are mounted under `/orgs` (org+project path style) so the dashboard
// can address every surface with the same prefix:
//   /orgs/:orgId/runs/:runId/location                            — location
//   /orgs/:orgId/projects/:projectId/runs                        — list
//   /orgs/:orgId/projects/:projectId/runs/:runId                 — detail
//   /orgs/:orgId/projects/:projectId/runs/:runId/events          — paginated
//   /orgs/:orgId/projects/:projectId/runs/:runId/costs           — paginated
//   /orgs/:orgId/projects/:projectId/runs/:runId/forge           — thread + turns
//   /orgs/:orgId/projects/:projectId/runs/:runId/stream          — SSE
//   /orgs/:orgId/projects/:projectId/feed                        — activity feed

import { PgNotifyListener, runWithOrgScope } from "@tanren/db";
import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { assertProjectAccess, assertRunAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { ForgeThreadStore, ForgeTurnStore } from "../../engine/forge/index.js";
import { loadInsightsForProject } from "../../engine/insights/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { type RunDetail, type RunListItem, type RunLocation, RECENT_EVENT_CAP } from "./contract.js";
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
  fetchRunTasks,
} from "./list.js";
import { registerOrgCostsRoute } from "./orgCostsRoute.js";
import { registerProjectProgressRoute } from "./progressRoute.js";
import { handleSseStream } from "./sse.js";
import { parseRawViewOptIn } from "./redaction.js";

interface RunRoutesOptions {
  pool: pg.Pool;
  // Safety-net backstop between SSE re-polls. With LISTEN/NOTIFY wired (the
  // default below) the stream wakes on `tanren_run` NOTIFYs and this only bounds
  // latency on a missed notification. Tests override it (often to 0).
  sseIntervalMs?: number;
  // Optional clock override for deterministic SSE heartbeats in tests.
  sseNow?: () => Date;
  // LISTEN/NOTIFY wake source for SSE. Defaults to a single process-wide
  // `PgNotifyListener` (one held connection shared across all run streams);
  // tests can inject their own or rely on the backstop poll.
  sseNotifyListener?: PgNotifyListener;
}

export function createRunRoutes(options: RunRoutesOptions) {
  // LISTEN/NOTIFY: ONE shared listener per route module — a single held LISTEN
  // connection that every concurrent run stream subscribes to (filtering by run
  // id), NOT a connection per stream. Built lazily off the route pool; its
  // `.connect()` delegates through the org-scoping proxy to the real pool.
  const sseNotifyListener = options.sseNotifyListener ?? new PgNotifyListener(options.pool);
  const app = new Hono<ActorContextEnv>();

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/runs/:runId/location
  // -------------------------------------------------------------------------
  // The dashboard's run route intentionally omits a project segment. Resolve its
  // location with one org-scoped run lookup rather than enumerating every
  // accessible project and its runs. A missing run, cross-org run, a run in an
  // inaccessible project, and a project whose org does not match the path org
  // all use the same 404 shape. Org authorization runs before the run read;
  // project authorization binds `assertProjectAccess` orgId to the path org
  // (including platform:admin) before any location is returned.
  app.get("/:orgId/runs/:runId/location", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const runId = c.req.param("runId");
    const summary = await runWithOrgScope(options.pool, orgId, (client) => fetchRunSummary(client, runId, orgId));
    if (summary === undefined) {
      return c.json({ error: "run_not_found" }, 404);
    }
    try {
      const projectAuth = await assertProjectAccess(options.pool, summary.projectId, actor);
      // Path/run organization must equal the project's organization — independent
      // FKs on runs.project_id and runs.org_id do not prevent inconsistency.
      if (projectAuth.orgId !== orgId) {
        return c.json({ error: "run_not_found" }, 404);
      }
    } catch (error) {
      if (error instanceof ToolAccessDeniedError) {
        return c.json({ error: "run_not_found" }, 404);
      }
      throw error;
    }
    const location: RunLocation = { orgId, projectId: summary.projectId };
    return c.json(location);
  });

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

    // RLS R2 cohort-1 (runs read): the run-list query runs through the org-scoped
    // client so it executes inside `SET LOCAL app.current_org_id = <orgId>` (org
    // validated against the actor above). Inert in R1 — no policies read the GUC
    // — and behavior-identical to the pool path.
    const items = await runWithOrgScope(options.pool, orgId, (client) =>
      fetchRunListItems(client, {
        projectId,
        orgId,
        status: c.req.query("status"),
        specId: c.req.query("specId"),
      }),
    );
    return c.json({ items });
  });

  registerOrgCostsRoute(app, options.pool);

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

    // RLS wave R1 reference conversion (read path): the run/spec/tasks/events/
    // costs loaders run through the org-scoped client so their SELECTs execute
    // inside a `SET LOCAL app.current_org_id = <orgId>` transaction (the org is
    // the path org, already validated against the actor above). Inert in R1 —
    // no policies read the GUC yet — and behavior-identical to the pool path.
    // Insights (touches the workflow_insights cache) stays on the pool; it
    // converts in a later R-wave. The Forge bundle (cross-store) converted in
    // R2 cohort-4 — `fetchForgeBundle` now opens its own org-scoped txn.
    const summary = await runWithOrgScope(options.pool, orgId, (client) => fetchRunSummary(client, runId, orgId));
    if (summary === undefined) {
      return c.json({ error: "run_not_found" }, 404);
    }
    if (summary.projectId !== projectId) {
      return c.json({ error: "run_not_found" }, 404);
    }
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    const rawView = parseRawViewOptIn(c);
    const [spec, tasks, recentEvents, costs] = await runWithOrgScope(options.pool, orgId, (client) =>
      Promise.all([
        fetchRunSpecSummary(client, summary.specId),
        fetchRunTasks(client, runId, orgId),
        fetchRunEventsForSnapshot(client, { runId, orgId, limit: RECENT_EVENT_CAP, actor, rawView }),
        fetchRunCostsForSnapshot(client, runId, orgId),
      ]),
    );
    // No silent fallback: a run ALWAYS references a real spec (FK), so a missing
    // spec here is a required relation failure — the row is gone or RLS-denied it.
    // Surface it loudly (404) rather than fabricating a `(spec not found)`
    // placeholder that masks the broken run→spec relation.
    if (spec === undefined) {
      return c.json({ error: "run_spec_not_found", specId: summary.specId }, 404);
    }

    const [insights, forgeThread] = await Promise.all([
      fetchRunInsights(options.pool, summary.projectId, summary.specId, runId),
      fetchForgeBundle(options.pool, { orgId, projectId, runId, actor }),
    ]);

    const detail: RunDetail = {
      run: summary,
      spec,
      tasks,
      recentEvents,
      costs,
      insights,
      forgeThread,
    };
    return c.json(detail);
  });

  // The paginated events + costs reads share the same run-access gate and
  // cursor-error mapping; registered together to keep this builder focused.
  registerRunPaginationRoutes(app, options);

  // The single "where is my project" aggregate (project-progress). Reuses the
  // same org-scope discipline as the spec/run/feed reads; kept in its own
  // builder so `createRunRoutes` stays a focused factory.
  registerProjectProgressRoute(app, options);

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
      orgId,
      actor,
      rawView: parseRawViewOptIn(c),
      // Backstop only: the stream wakes on `tanren_run` NOTIFYs for this run; the
      // interval bounds latency if one is ever missed. 20s mirrors the worker's
      // backstop.
      intervalMs: options.sseIntervalMs ?? 20_000,
      notifyListener: sseNotifyListener,
      now: options.sseNow,
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
      // RLS R2 cohort-1 (events read): the project activity feed reads `events`
      // through the org-scoped client (inert in R1; same rows as the pool path).
      const page = await runWithOrgScope(options.pool, orgId, (client) =>
        fetchFeedPage(client, {
          projectId,
          orgId,
          cursor: c.req.query("cursor"),
          pageSize: c.req.query("pageSize"),
          actor,
          rawView: parseRawViewOptIn(c),
        }),
      );
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
// The two paginated reads (events + costs) under a run. Both gate on run
// access, run their query through the org-scoped client, and map an
// `invalid_cursor` into a 400 — extracted as a unit so `createRunRoutes` stays
// a focused builder. Behavior is identical to the inline registrations.
// ---------------------------------------------------------------------------

function registerRunPaginationRoutes(app: Hono<ActorContextEnv>, options: RunRoutesOptions): void {
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
      // RLS R2 cohort-1 (events read): the paginated events query runs through
      // the org-scoped client (inert in R1; same rows as the pool path).
      const page = await runWithOrgScope(options.pool, orgId, (client) =>
        fetchEventsPage(client, {
          runId,
          orgId,
          cursor: c.req.query("cursor"),
          pageSize: c.req.query("pageSize"),
          actor,
          rawView: parseRawViewOptIn(c),
        }),
      );
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });

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
      // RLS R2 cohort-2 (cost_records read): the paginated costs query runs
      // through the org-scoped client (inert in R1; same rows as the pool path).
      const page = await runWithOrgScope(options.pool, orgId, (client) =>
        fetchCostsPage(client, {
          runId,
          orgId,
          cursor: c.req.query("cursor"),
          pageSize: c.req.query("pageSize"),
        }),
      );
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });
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
  c: Context,
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

async function fetchForgeBundle(pool: pg.Pool, args: ForgeBundleArgs): Promise<RunDetail["forgeThread"]> {
  // RLS R2 cohort-4 (forge): the run-detail Forge bundle's cross-store reads
  // (listForRun + turns) run in one org-scoped txn (org = args.orgId, already
  // validated against the actor at the route, and the project access gated). The
  // genuine "no Forge narration yet" case is `head === undefined → null`.
  //
  // No silent fallback: a thrown store/read error here is NOT "no narration" — it
  // is a failed read (a transport error, a corrupt thread row, an unexpectedly
  // denied scope). The actor was already validated against the org/project at the
  // route, so an access throw is itself a real fault to surface, not a benign
  // "this actor can't see the thread". Let it PROPAGATE so the route 500s loudly
  // rather than rendering a falsely-empty Forge panel that masks the failure.
  return await runWithOrgScope(pool, args.orgId, async (client) => {
    const threads = await ForgeThreadStore.listForRun(
      client,
      { orgId: args.orgId, projectId: args.projectId, runId: args.runId },
      args.actor,
    );
    const head = threads[0];
    if (head === undefined) return null;
    const turns = await ForgeTurnStore.list(client, { threadId: head.id, limit: 50 }, args.actor);
    return { threadId: head.id, recentTurns: turns };
  });
}

// Re-export so 2B can import insight typing from a single point.
export type { Insight } from "../../engine/insights/index.js";
// Re-export contract types for downstream test imports.
export type { RunListItem, RunDetail };
// Plus the bundle insight loader helper (rarely needed but useful for SSE
// extension paths). The actual call lives in list.ts.
export { loadInsightsForProject };
