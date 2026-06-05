// (additive): thin HTTP surface over the notifications
// engine. shipped the schema, store, matrix evaluator, and ntfy
// channel but no HTTP routes; the dashboard is a separate process and needs
// to read/write `notification_targets` + `notification_routes` over HTTP to
// make the notifications-matrix UI functional. This file ONLY wraps the
// existing `NotificationTargetStore` / `NotificationRouteStore` and the
// sealed `eventDefaultSeverity` map — no new schema, no migration, no change
// to existing route logic.

import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { eventDefaultSeverity } from "../../engine/notifications/eventDefaultSeverity.js";
import {
  NotificationRouteCreateInput,
  NotificationRouteStore,
  NotificationTargetCreateInput,
  NotificationTargetStore,
} from "../../engine/notifications/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

interface NotificationRoutesOptions {
  pool: pg.Pool;
}

/** Every event-registry row + its default severity, for the matrix rows. */
function eventCatalog(): Array<{ eventName: string; defaultSeverity: string }> {
  return Object.entries(eventDefaultSeverity)
    .map(([eventName, defaultSeverity]) => ({ eventName, defaultSeverity }))
    .sort((a, b) => a.eventName.localeCompare(b.eventName));
}

export function createNotificationRoutes(options: NotificationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  // The full matrix payload: every configured target, every route opt-in
  // across those targets, and the event catalog with default severities.
  app.get("/:orgId/notifications/matrix", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const targets = await NotificationTargetStore.listForOrg(options.pool, orgId);
    const routes = [];
    for (const target of targets) {
      routes.push(...(await NotificationRouteStore.listForTarget(options.pool, target.id)));
    }
    return c.json({
      targets: targets.map((target) => toTargetContract(target)),
      routes: routes.map((route) => toRouteContract(route)),
      events: eventCatalog(),
    });
  });

  app.post("/:orgId/notifications/targets", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // user-scope rows are bound to the requesting actor (dev override layer).
    const scope = raw["scope"] === "user" ? "user" : "org";
    const parsed = NotificationTargetCreateInput.safeParse({
      ...raw,
      orgId,
      scope,
      userId: scope === "user" ? actor.userId : null,
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_target", issues: parsed.error.issues }, 400);
    }
    const created = await NotificationTargetStore.create(options.pool, parsed.data);
    return c.json(toTargetContract(created), 201);
  });

  app.post("/:orgId/notifications/routes", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = NotificationRouteCreateInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_route", issues: parsed.error.issues }, 400);
    }
    // The target must belong to this org (defense against cross-org writes).
    const target = await NotificationTargetStore.get(options.pool, parsed.data.targetId);
    if (target === undefined || target.orgId !== orgId) {
      return c.json({ error: "target_not_found" }, 404);
    }
    const created = await NotificationRouteStore.create(options.pool, parsed.data);
    return c.json(toRouteContract(created), 201);
  });

  return app;
}

function toTargetContract(row: {
  id: string;
  orgId: string;
  scope: "org" | "user";
  userId: string | null;
  channelKind: string;
  destination: string;
  label: string;
  enabled: boolean;
  weekendMute: boolean;
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    scope: row.scope,
    userId: row.userId,
    channelKind: row.channelKind,
    destination: row.destination,
    label: row.label,
    enabled: row.enabled,
    weekendMute: row.weekendMute,
  };
}

function toRouteContract(row: {
  id: string;
  targetId: string;
  eventName: string;
  enabled: boolean;
  minSeverity: string;
}) {
  return {
    id: row.id,
    targetId: row.targetId,
    eventName: row.eventName,
    enabled: row.enabled,
    minSeverity: row.minSeverity,
  };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
