// P2A-0013: milestone CRUD routes. Milestones are project-scoped and ordered.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { MilestoneStatus, MilestoneStore } from "../../engine/entities/milestones.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface MilestoneRoutesOptions {
  pool: pg.Pool;
}

const MilestoneCreateBody = z.object({
  label: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  orderIndex: z.number().int(),
  eta: z.string().datetime().nullable().optional(),
  status: MilestoneStatus.optional()
});

export function createMilestoneRoutes(options: MilestoneRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/milestones", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const rows = await MilestoneStore.listForProject(
        options.pool,
        projectId,
        { ...actor, orgId, projectId }
      );
      return c.json({ milestones: rows });
    } catch (error) {
      return c.json({ error: "milestone_access_denied", message: messageOf(error) }, 403);
    }
  });

  app.post("/:orgId/projects/:projectId/milestones", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = MilestoneCreateBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_milestone", issues: parsed.error.issues }, 400);
    }
    const data = parsed.data;
    try {
      const milestone = await MilestoneStore.create(
        options.pool,
        {
          projectId,
          label: data.label,
          name: data.name,
          description: data.description ?? null,
          orderIndex: data.orderIndex,
          eta: data.eta === undefined || data.eta === null ? null : new Date(data.eta),
          status: data.status ?? "planned"
        },
        { ...actor, orgId, projectId }
      );
      return c.json(milestone, 201);
    } catch (error) {
      return c.json({ error: "milestone_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/projects/:projectId/milestones/:milestoneId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const milestoneId = c.req.param("milestoneId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const milestone = await MilestoneStore.get(options.pool, milestoneId, { ...actor, orgId, projectId });
      if (milestone === undefined) {
        return c.json({ error: "milestone_not_found" }, 404);
      }
      return c.json(milestone);
    } catch (error) {
      return c.json({ error: "milestone_access_denied", message: messageOf(error) }, 403);
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
