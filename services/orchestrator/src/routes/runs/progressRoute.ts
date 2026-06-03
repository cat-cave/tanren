// GET /orgs/:orgId/projects/:projectId/progress — the single "where is my
// project" aggregate. Mirrors the spec/run/feed authz (requireActor +
// actorCanAccessOrg + the project-access gate) and reuses their org-scoped
// reads verbatim: the spec list (`projectSpecs.listForProject`), the project
// run list (`fetchRunListItems`), and the activity feed (`fetchFeedPage`). The
// fold into the aggregate lives in `buildProjectProgress` (pure, no I/O). A
// read-only mirror of the dashboard — no writes, no side effects, no secrets
// (the feed is loaded WITHOUT raw-view, so payloads stay redacted).
//
// Extracted from routes/runs/index.ts so that file stays under its line +
// dependency caps: the progress surface carries its own repository/read imports.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { pgRepositories } from "../../engine/contracts/repositories.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import { ProjectStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";
import { fetchFeedPage, fetchRunListItems } from "./list.js";
import { buildProjectProgress, RECENT_MILESTONE_CAP } from "./progress.js";

export function registerProjectProgressRoute(app: Hono<ActorContextEnv>, options: { pool: pg.Pool }): void {
  app.get("/:orgId/projects/:projectId/progress", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const projectId = c.req.param("projectId");
    const denial = await gateProjectAccess(options.pool, projectId, actor, c);
    if (denial !== undefined) return denial;

    // One org-scoped transaction for all three reads (same scope discipline the
    // sibling routes use). The feed is loaded a generous window deep (newest
    // first) and reused three ways in the pure reducer — recentMilestones, the
    // per-inFlight-run `stage` (latest event per run), and the top-level
    // `lastActivityAt` (the head event's ts) — so the live-progress signals add
    // ZERO extra queries. The window is enough to fill the last-~20 milestones
    // and reach each active run's latest event without paging the whole history.
    const { project, specs, runs, feed } = await runWithOrgScope(options.pool, orgId, async (client) => {
      const projectRow = await ProjectStore.get(client, projectId, systemActor);
      const specRows = await pgRepositories.projectSpecs.listForProject(client, projectId, systemActor);
      const runItems = await fetchRunListItems(client, { projectId, orgId, status: undefined, specId: undefined });
      const feedPage = await fetchFeedPage(client, {
        projectId,
        orgId,
        cursor: undefined,
        // A milestone is a fraction of the feed; pull a generous window so the
        // top ~20 milestones are present even when interleaved with noise.
        pageSize: String(RECENT_MILESTONE_CAP * 10),
        actor,
        // Redacted view ONLY — the progress surface never opts into raw values.
        rawView: false,
      });
      return { project: projectRow, specs: specRows, runs: runItems, feed: feedPage.items };
    });

    // The project-access gate above already authorized the actor against the
    // project; this is the same defense-in-depth tenant check the project-read
    // route applies (a non-null org_id must match the path org).
    if (project === undefined) {
      return c.json({ error: "project_not_found" }, 404);
    }
    if (project.orgId !== null && project.orgId !== undefined && project.orgId !== orgId) {
      return c.json({ error: "project_not_found" }, 404);
    }
    const progress = buildProjectProgress({
      project: { id: project.projectId, name: project.name, repoUrl: project.repoUrl },
      specs,
      runs,
      feed,
    });
    return c.json(progress);
  });
}

// Same project-access gate the run/feed routes use: ToolAccessDeniedError is the
// project-access miss, folded into a 403. Returns undefined on success or the
// denial Response to short-circuit on.
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
