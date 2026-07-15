import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
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

function harness() {
  const pool = new NotificationMemoryClient();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createNotificationRoutes({ pool: pool as never }));
  return { app, pool };
}

describe("notification matrix route query", () => {
  it("loads all matrix routes with one org-scoped query and excludes foreign targets", async () => {
    const { app, pool } = harness();
    for (const [id, orgId] of [
      ["notif_target_first", "org_acme"],
      ["notif_target_second", "org_acme"],
      ["notif_target_foreign", "org_other"],
    ] as const) {
      pool.targets.set(id, {
        id,
        org_id: orgId,
        scope: "org",
        user_id: null,
        channel_kind: "ntfy",
        destination: `https://ntfy.sh/${id}`,
        label: id,
        enabled: 1,
        weekend_mute: 0,
        created_at: pool.now,
        updated_at: pool.now,
      });
    }
    for (const [id, targetId, eventName] of [
      ["notif_route_first", "notif_target_first", "run.failed"],
      ["notif_route_second", "notif_target_second", "run.completed"],
      ["notif_route_foreign", "notif_target_foreign", "run.failed"],
    ] as const) {
      pool.routes.set(id, {
        id,
        target_id: targetId,
        event_name: eventName,
        enabled: 1,
        min_severity: "info",
        created_at: pool.now,
        updated_at: pool.now,
      });
    }
    const matrix = (await (await app.request("/orgs/org_acme/notifications/matrix")).json()) as {
      targets: Array<{ id: string }>;
      routes: Array<{ id: string; targetId: string }>;
    };
    expect(matrix.targets.map((target) => target.id)).toEqual(["notif_target_first", "notif_target_second"]);
    expect(matrix.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "notif_route_first", targetId: "notif_target_first" }),
        expect.objectContaining({ id: "notif_route_second", targetId: "notif_target_second" }),
      ]),
    );
    expect(matrix.routes).toHaveLength(2);
    const routeQueries = pool.queries.filter(({ sql }) => sql.includes("FROM notification_routes"));
    expect(routeQueries).toHaveLength(1);
    expect(routeQueries[0]?.sql).toContain("JOIN notification_targets t ON r.target_id = t.id");
    expect(routeQueries[0]?.sql).toContain("WHERE t.org_id = $1");
    expect(routeQueries[0]?.params).toEqual(["org_acme"]);
  });
});
