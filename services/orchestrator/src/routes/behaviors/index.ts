// P2A-0013: behavior CRUD routes. Behaviors are owned by a persona; the
// persona's org/project scoping is the authorization boundary.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { BehaviorStore } from "../../engine/entities/behaviors.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface BehaviorRoutesOptions {
  pool: pg.Pool;
}

/* eslint-disable unicorn/no-thenable */
// "then" is part of the BDD Given/When/Then vocabulary used by P2A-0018
// behaviors. The lint warning about thenable objects does not apply to a Zod
// schema field name; this disable mirrors the engine BehaviorRow schema.
const BehaviorCreateBody = z.object({
  personaId: z.string().min(1),
  title: z.string().min(1),
  given: z.string().default(""),
  when: z.string().default(""),
  then: z.string().default(""),
  description: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/* eslint-enable unicorn/no-thenable */

export function createBehaviorRoutes(options: BehaviorRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/projects/:projectId/behaviors", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const personaId = c.req.query("personaId");
    if (personaId === undefined || personaId === "") {
      return c.json({ error: "persona_id_required", message: "personaId query parameter is required" }, 400);
    }
    try {
      const rows = await BehaviorStore.listForPersona(options.pool, personaId, { ...actor, orgId });
      return c.json({ behaviors: rows });
    } catch (error) {
      return c.json({ error: "behavior_access_denied", message: messageOf(error) }, 403);
    }
  });

  app.post("/:orgId/projects/:projectId/behaviors", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = BehaviorCreateBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_behavior", issues: parsed.error.issues }, 400);
    }
    try {
      /* eslint-disable unicorn/no-thenable */
      const behavior = await BehaviorStore.create(
        options.pool,
        {
          personaId: parsed.data.personaId,
          title: parsed.data.title,
          given: parsed.data.given,
          when: parsed.data.when,
          then: parsed.data.then,
          description: parsed.data.description ?? null,
          metadata: parsed.data.metadata ?? {},
        },
        { ...actor, orgId },
      );
      /* eslint-enable unicorn/no-thenable */
      return c.json(behavior, 201);
    } catch (error) {
      return c.json({ error: "behavior_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/projects/:projectId/behaviors/:behaviorId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const behaviorId = c.req.param("behaviorId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const behavior = await BehaviorStore.get(options.pool, behaviorId, { ...actor, orgId });
      if (behavior === undefined) {
        return c.json({ error: "behavior_not_found" }, 404);
      }
      return c.json(behavior);
    } catch (error) {
      return c.json({ error: "behavior_access_denied", message: messageOf(error) }, 403);
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
