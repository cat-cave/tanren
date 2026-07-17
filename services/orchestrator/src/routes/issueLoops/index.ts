// bh-1 — the read HTTP surface for the IssueLoop aggregate. Org/project-scoped
// list + get of issue loops, and the immutable source findings of a loop. This
// is the "callable" proof of the back-half foundation; the resolution DAG (bh-6)
// and the operator/command surfaces land in later bh nodes.
//
// Mounted at "/orgs", so the external paths are:
//   GET /orgs/:orgId/projects/:projectId/issue-loops
//   GET /orgs/:orgId/projects/:projectId/issue-loops/:loopId
//   GET /orgs/:orgId/projects/:projectId/issue-loops/:loopId/findings
//
// Every read runs on the org-scoping pool under the request's org GUC, so RLS
// denies rows from any other tenant by default.

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { IssueLoopStore } from "../../engine/repositories/issueLoops.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface IssueLoopRoutesOptions {
  readonly pool: pg.Pool;
}

type RouteContext = Context<ActorContextEnv>;

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

function authorize(c: RouteContext): { orgId: string; projectId: string } | Response {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  return { orgId, projectId };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

export function createIssueLoopRoutes(options: IssueLoopRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/issue-loops", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: "invalid_limit" }, 400);
    }
    const loops = await runWithOrgScope(options.pool, scope.orgId, (client) =>
      IssueLoopStore.listForProject(client, scope.orgId, scope.projectId, limit === undefined ? {} : { limit }),
    );
    return c.json({ version: "v1" as const, ...scope, issueLoops: loops });
  });

  app.get("/:orgId/projects/:projectId/issue-loops/:loopId", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const loopId = requireParam(c, "loopId");
    const loop = await runWithOrgScope(options.pool, scope.orgId, (client) =>
      IssueLoopStore.get(client, scope.orgId, scope.projectId, loopId),
    );
    if (loop === undefined) return c.json({ error: "issue_loop_not_found" }, 404);
    return c.json({ version: "v1" as const, ...scope, issueLoop: loop });
  });

  app.get("/:orgId/projects/:projectId/issue-loops/:loopId/findings", async (c) => {
    const scope = authorize(c);
    if (isResponse(scope)) return scope;
    const loopId = requireParam(c, "loopId");
    const result = await runWithOrgScope(options.pool, scope.orgId, async (client) => {
      const loop = await IssueLoopStore.get(client, scope.orgId, scope.projectId, loopId);
      if (loop === undefined) return { found: false as const };
      const findings = await IssueLoopStore.listFindings(client, scope.orgId, loopId);
      return { found: true as const, findings };
    });
    if (!result.found) return c.json({ error: "issue_loop_not_found" }, 404);
    return c.json({ version: "v1" as const, ...scope, loopId, findings: result.findings });
  });

  return app;
}
