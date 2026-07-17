// gv-6: contract tests for the notification-route MUTATION surface — the
// `PUT /:orgId/notifications/routes/:id` toggle (enabled / minSeverity) and
// `DELETE /:orgId/notifications/routes/:id`. Split out of
// notificationsRoutes.contract.test.ts to keep each file under the 500-line cap;
// same assertions, no behavior change. Reuses the in-memory notification pg
// substitute.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ChannelKind } from "../src/engine/notifications/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createNotificationRoutes } from "../src/routes/notifications/index.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function harness(who: ActorContext | undefined = actor, wiredChannelKinds?: ReadonlySet<ChannelKind>) {
  const pool = new NotificationMemoryClient();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return who as ActorContext;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route(
    "/orgs",
    createNotificationRoutes({
      pool: pool as never,
      ...(wiredChannelKinds !== undefined && { wiredChannelKinds }),
    }),
  );
  return { app, pool };
}

async function createRoute(app: ReturnType<typeof harness>["app"]): Promise<{ targetId: string; routeId: string }> {
  const target = (await (
    await app.request("/orgs/org_acme/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelKind: "ntfy", destination: "https://ntfy.sh/toggle", label: "toggle" }),
    })
  ).json()) as { id: string };
  const route = (await (
    await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: target.id, eventName: "run.failed", minSeverity: "info", enabled: true }),
    })
  ).json()) as { id: string };
  return { targetId: target.id, routeId: route.id };
}

describe("notification route mutation surface (PUT/DELETE routes/:id)", () => {
  it("PUT toggles a route's enabled flag and reflects it in the matrix", async () => {
    const { app } = harness();
    const { routeId } = await createRoute(app);

    const put = await app.request(`/orgs/org_acme/notifications/routes/${routeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { enabled: boolean }).enabled).toBe(false);

    const matrix = (await (await app.request("/orgs/org_acme/notifications/matrix")).json()) as {
      routes: Array<{ id: string; enabled: boolean }>;
    };
    expect(matrix.routes.find((r) => r.id === routeId)?.enabled).toBe(false);
  });

  it("PUT can move the minSeverity floor", async () => {
    const { app } = harness();
    const { routeId } = await createRoute(app);
    const put = await app.request(`/orgs/org_acme/notifications/routes/${routeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minSeverity: "fail" }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { minSeverity: string }).minSeverity).toBe("fail");
  });

  it("PUT rejects an empty body with 400 invalid_route_update", async () => {
    const { app } = harness();
    const { routeId } = await createRoute(app);
    const put = await app.request(`/orgs/org_acme/notifications/routes/${routeId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe("invalid_route_update");
  });

  it("PUT on a missing route id is 404 route_not_found", async () => {
    const { app } = harness();
    const put = await app.request("/orgs/org_acme/notifications/routes/notif_route_missing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(404);
    expect(((await put.json()) as { error: string }).error).toBe("route_not_found");
  });

  it("PUT to a cross-org route id is a 404 (target join hides the foreign row)", async () => {
    const { app, pool } = harness();
    // Seed a foreign-org target + route directly.
    pool.targets.set("notif_target_other", {
      id: "notif_target_other",
      org_id: "org_other",
      scope: "org",
      user_id: null,
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/o",
      label: "o",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });
    pool.routes.set("notif_route_other", {
      id: "notif_route_other",
      target_id: "notif_target_other",
      event_name: "run.failed",
      enabled: 1,
      min_severity: "info",
      created_at: pool.now,
      updated_at: pool.now,
    });
    const put = await app.request("/orgs/org_acme/notifications/routes/notif_route_other", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(put.status).toBe(404);
  });

  it("PUT rejects re-enabling a route to an unwired channel when wiredChannelKinds is provided", async () => {
    const { app, pool } = harness(actor, new Set(["ntfy"] as const));
    pool.targets.set("notif_target_teams", {
      id: "notif_target_teams",
      org_id: "org_acme",
      scope: "org",
      user_id: null,
      channel_kind: "teams",
      destination: "teams-dest",
      label: "teams",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });
    pool.routes.set("notif_route_teams", {
      id: "notif_route_teams",
      target_id: "notif_target_teams",
      event_name: "run.failed",
      enabled: 0,
      min_severity: "info",
      created_at: pool.now,
      updated_at: pool.now,
    });
    const put = await app.request("/orgs/org_acme/notifications/routes/notif_route_teams", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toBe("channel_not_wired");
    // Disabling the same route stays allowed even on an unwired channel.
    const disable = await app.request("/orgs/org_acme/notifications/routes/notif_route_teams", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
  });

  it("DELETE removes a route and drops it from the matrix", async () => {
    const { app } = harness();
    const { routeId } = await createRoute(app);
    const del = await app.request(`/orgs/org_acme/notifications/routes/${routeId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    const matrix = (await (await app.request("/orgs/org_acme/notifications/matrix")).json()) as {
      routes: Array<{ id: string }>;
    };
    expect(matrix.routes.find((r) => r.id === routeId)).toBeUndefined();

    // A second DELETE is a 404 (already gone).
    const again = await app.request(`/orgs/org_acme/notifications/routes/${routeId}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("DELETE on a cross-org route id is a 404", async () => {
    const { app } = harness();
    const del = await app.request("/orgs/org_intruder/notifications/routes/notif_route_x", { method: "DELETE" });
    // Actor cannot access org_intruder → 403 org guard before any lookup.
    expect(del.status).toBe(403);
  });
});
