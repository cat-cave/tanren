// persona CRUD routes. Personas are owned by an org and optionally
// project-scoped. The store enforces visibility — these handlers only translate
// HTTP shapes and surface common error cases.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { PersonaStore } from "../../engine/entities/personas.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface PersonaRoutesOptions {
  pool: pg.Pool;
}

const PersonaCreateBody = z.object({
  scope: z.enum(["org", "project"]).default("org"),
  name: z.string().min(1),
  description: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function createPersonaRoutes(options: PersonaRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/personas", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const rows = await PersonaStore.listForOrg(options.pool, orgId, { ...actor, orgId });
      return c.json({ personas: rows });
    } catch (error) {
      return c.json({ error: "persona_access_denied", message: messageOf(error) }, 403);
    }
  });

  app.post("/:orgId/personas", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = PersonaCreateBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_persona", issues: parsed.error.issues }, 400);
    }
    if (parsed.data.scope === "project") {
      return c.json(
        {
          error: "invalid_persona",
          message: "project-scoped personas must be created under /projects/:projectId/personas",
        },
        400,
      );
    }
    try {
      const persona = await PersonaStore.create(
        options.pool,
        {
          scope: parsed.data.scope,
          orgId,
          projectId: null,
          name: parsed.data.name,
          description: parsed.data.description,
          metadata: parsed.data.metadata ?? {},
        },
        { ...actor, orgId },
      );
      return c.json(persona, 201);
    } catch (error) {
      return c.json({ error: "persona_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/projects/:projectId/personas", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const rows = await PersonaStore.listForProject(
        options.pool,
        { orgId, projectId },
        { ...actor, orgId, projectId },
      );
      return c.json({ personas: rows });
    } catch (error) {
      return c.json({ error: "persona_access_denied", message: messageOf(error) }, 403);
    }
  });

  app.post("/:orgId/projects/:projectId/personas", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = PersonaCreateBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_persona", issues: parsed.error.issues }, 400);
    }
    try {
      const persona = await PersonaStore.create(
        options.pool,
        {
          scope: "project",
          orgId,
          projectId,
          name: parsed.data.name,
          description: parsed.data.description,
          metadata: parsed.data.metadata ?? {},
        },
        { ...actor, orgId, projectId },
      );
      return c.json(persona, 201);
    } catch (error) {
      return c.json({ error: "persona_create_failed", message: messageOf(error) }, 400);
    }
  });

  app.get("/:orgId/personas/:personaId", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const personaId = c.req.param("personaId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const persona = await PersonaStore.get(options.pool, personaId, { ...actor, orgId });
      if (persona === undefined) {
        return c.json({ error: "persona_not_found" }, 404);
      }
      return c.json(persona);
    } catch (error) {
      return c.json({ error: "persona_access_denied", message: messageOf(error) }, 403);
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
