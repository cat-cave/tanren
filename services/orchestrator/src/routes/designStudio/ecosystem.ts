// ds-8 — org-admin command and metadata-only public design ecosystem routes.

import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  DesignEcosystemCommandSchema,
  DesignEcosystemError,
  DesignEcosystemReadStore,
  DesignEcosystemService,
  type DesignEcosystemExecution,
} from "../../engine/design/system/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

type RouteContext = Context<ActorContextEnv>;

export interface DesignEcosystemRoutesOptions {
  readonly pool: pg.Pool;
  readonly service?: Pick<DesignEcosystemService, "execute" | "readPublic">;
  readonly readStore?: Pick<DesignEcosystemReadStore, "listStudio">;
}

function actor(c: RouteContext): ActorContext {
  const value = c.var.actor;
  if (value === undefined) throw new Error("actor missing on context");
  return value;
}

function nonblankParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

function errorResponse(c: RouteContext, error: unknown): Response | undefined {
  if (!(error instanceof DesignEcosystemError)) return undefined;
  const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 409;
  return c.json({ error: error.code }, status);
}

/** `/v1/orgs/:orgId/design-ecosystem/commands`, the one production command entry point. */
export function createDesignEcosystemRoutes(options: DesignEcosystemRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const service = options.service ?? new DesignEcosystemService(options.pool);
  const readStore = options.readStore ?? new DesignEcosystemReadStore(options.pool);
  app.get("/:orgId/design-ecosystem", async (c) => {
    const current = actor(c);
    const orgId = nonblankParam(c, "orgId");
    if (!actorCanAccessOrg(current, orgId)) return c.json({ error: "org_access_denied" }, 403);
    try {
      return c.json({ version: "v1", orgId, ...(await readStore.listStudio(orgId)) });
    } catch (error) {
      const response = errorResponse(c, error);
      if (response !== undefined) return response;
      throw error;
    }
  });
  app.post("/:orgId/design-ecosystem/commands", async (c) => {
    const current = actor(c);
    const orgId = nonblankParam(c, "orgId");
    if (!actorCanAccessOrg(current, orgId)) return c.json({ error: "org_access_denied" }, 403);
    if (!actorIsOrgAdmin(current, orgId)) return c.json({ error: "org_admin_required" }, 403);
    const idempotencyKey = c.req.header("idempotency-key");
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      return c.json({ error: "idempotency_key_required" }, 400);
    }
    const parsed = DesignEcosystemCommandSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_design_ecosystem_command", issues: parsed.error.issues }, 400);
    const execution: DesignEcosystemExecution = {
      orgId,
      actorId: current.userId,
      idempotencyKey,
      command: parsed.data,
    };
    try {
      // The result types deliberately omit any input bearer token and any byte URL.
      return c.json(await service.execute(execution));
    } catch (error) {
      const response = errorResponse(c, error);
      if (response !== undefined) return response;
      throw error;
    }
  });
  return app;
}

/** `/v1/public/...`: a sanitized catalog metadata projection, explicitly never a download route. */
export function createDesignPublicRoutes(options: DesignEcosystemRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const service = options.service ?? new DesignEcosystemService(options.pool);
  app.get("/public/design-system-releases/:publicationId", async (c) => {
    try {
      return c.json(await service.readPublic(nonblankParam(c, "publicationId")));
    } catch (error) {
      const response = errorResponse(c, error);
      if (response !== undefined) return response;
      throw error;
    }
  });
  return app;
}
