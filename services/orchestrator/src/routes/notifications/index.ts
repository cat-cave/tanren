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
  buildProductionChannelRegistry,
  type BuildNotificationDispatcherDeps,
  type ChannelKind,
  NotificationDispatchLog,
  NotificationRouteCreateInput,
  NotificationRouteStore,
  NotificationTargetCreateInput,
  NotificationTargetStore,
  type DispatchStatus,
} from "../../engine/notifications/index.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

interface NotificationRoutesOptions {
  pool: pg.Pool;
  /**
   * The set of channel kinds actually wired in this boot's registry. When
   * provided, `POST /orgs/:orgId/notifications/routes` REJECTS creating a
   * route to a target whose `channelKind` is NOT in the set — the runtime
   * companion to the boot-time `requiredChannels` guard so a stub can never
   * back a routed production channel (Codex H3 Surface 6 #18: ban stub-in-
   * prod routing). Omitted (and `productionChannelDeps` also omitted) → the
   * endpoint accepts any known kind (tests / dev harness).
   */
  wiredChannelKinds?: ReadonlySet<ChannelKind>;
  /**
   * Production channel deps (secret store, etc.). When provided, the endpoint
   * builds the SAME registry the worker boot uses and derives the wired set
   * from it. Prefer this to `wiredChannelKinds` when both the API and worker
   * share the same secret store — a single source of truth for the wired set.
   */
  productionChannelDeps?: BuildNotificationDispatcherDeps;
}

/** Every event-registry row + its default severity, for the matrix rows. */
function eventCatalog(): Array<{ eventName: string; defaultSeverity: string }> {
  return Object.entries(eventDefaultSeverity)
    .map(([eventName, defaultSeverity]) => ({ eventName, defaultSeverity }))
    .sort((a, b) => a.eventName.localeCompare(b.eventName));
}

const DELIVERY_STATUSES = new Set<DispatchStatus>([
  "sent",
  "failed",
  "stubbed",
  "skipped",
  // Codex H3 Surface 6 #19: durable no-route escalation records — filterable so
  // operators can enumerate the fail-severity events that reached no human.
  "undelivered_no_route",
]);

export function createNotificationRoutes(options: NotificationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  // Codex H3 Surface 6 #18: resolve the wired-channel set once per boot.
  // Prefer an explicitly-provided set; else, derive it from the shared
  // production channel deps so the API's guard matches the worker's registry.
  const wiredChannelKinds: ReadonlySet<ChannelKind> | undefined =
    options.wiredChannelKinds ??
    (options.productionChannelDeps === undefined
      ? undefined
      : buildProductionChannelRegistry(options.productionChannelDeps).wiredChannelKinds);

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

  app.get("/:orgId/notifications/deliveries", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }

    const status = c.req.query("status");
    if (status !== undefined && !DELIVERY_STATUSES.has(status as DispatchStatus)) {
      return c.json({ error: "invalid_status" }, 400);
    }

    const deliveries = await NotificationDispatchLog.listForOrg(options.pool, {
      orgId,
      limit: parseLimit(c.req.query("limit")),
      ...(c.req.query("eventName") === undefined ? {} : { eventName: c.req.query("eventName") }),
      ...(status === undefined ? {} : { status: status as DispatchStatus }),
    });

    return c.json({
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        orgId: delivery.orgId,
        channel: delivery.channel,
        status: delivery.status,
        attempts: delivery.attempts,
        enqueuedAt: delivery.enqueuedAt,
        sentAt: delivery.sentAt,
        eventName: delivery.eventName,
        targetId: delivery.targetId,
        severity: delivery.severity,
        title: delivery.title,
        reason: delivery.reason,
        layering: delivery.layering,
        target: delivery.target,
      })),
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
    // Codex H3 Surface 6 #18: BAN stub-in-prod routing. If the boot supplied
    // the set of wired channels, reject creating a route to a target whose
    // channelKind is not wired — a StubChannel publish is a no-op, so a route
    // to a stub silently drops fail-severity escalations. This is the
    // runtime companion to the boot-time `requiredChannels` guard in
    // `buildChannelRegistry`.
    if (wiredChannelKinds !== undefined && !wiredChannelKinds.has(target.channelKind)) {
      return c.json(
        {
          error: "channel_not_wired",
          channelKind: target.channelKind,
          detail:
            "cannot route to a channel whose adapter is not wired in this deploy (would silently stub fail-severity escalations)",
        },
        400,
      );
    }
    const created = await NotificationRouteStore.create(options.pool, parsed.data);
    return c.json(toRouteContract(created), 201);
  });

  return app;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function toTargetContract(row: {
  id: string;
  orgId: string;
  scope: "org" | "user";
  userId: string | null;
  channelKind: string;
  destination: string;
  baseUrl: string | null;
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
    // The per-org base URL (null ⇒ use the deploy default). Echoed so the
    // operator sees exactly what was persisted (API mirrors UX).
    baseUrl: row.baseUrl,
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
