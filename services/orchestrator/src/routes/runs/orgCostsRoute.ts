/** HTTP registration for the bounded, org-scoped costs read model. */

import { runWithOrgScope } from "@tanren/db";
import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";
import { fetchOrgCostsPage } from "./orgCosts.js";

export function registerOrgCostsRoute(app: Hono<ActorContextEnv>, pool: pg.Pool): void {
  // The costs page and CSV export consume this bounded org read model instead
  // of walking projects, runs, and per-run cost pages.
  app.get("/:orgId/costs", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    // Authorize before opening a scoped transaction or issuing any read.
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    try {
      const page = await runWithOrgScope(pool, orgId, async (client) => {
        // Both bounded store reads in this response observe one DB snapshot.
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        return fetchOrgCostsPage(client, {
          orgId,
          cursor: c.req.query("cursor"),
          pageSize: c.req.query("pageSize"),
        });
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("invalid_cursor")) {
        return c.json({ error: "invalid_cursor", message: error.message }, 400);
      }
      throw error;
    }
  });
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}
