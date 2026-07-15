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
  it("returns routes ordered by (event_name, target_id, id) with one org-scoped query, excluding foreign targets", async () => {
    const { app, pool } = harness();
    for (const [id, orgId] of [
      ["notif_target_a", "org_acme"],
      ["notif_target_b", "org_acme"],
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
    // Insertion order is deliberately SCRAMBLED relative to the production
    // ORDER BY (event_name, target_id, id): the two run.failed rows go in
    // reverse target order, then run.completed, then a foreign same-event
    // row. Map insertion order can never satisfy the asserted sequence, so a
    // missing/changed ORDER BY fails the test instead of passing by accident.
    for (const [id, targetId, eventName] of [
      ["notif_route_failed_b", "notif_target_b", "run.failed"],
      ["notif_route_completed_a", "notif_target_a", "run.completed"],
      ["notif_route_failed_a", "notif_target_a", "run.failed"],
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
      routes: Array<{
        id: string;
        targetId: string;
        eventName: string;
        enabled: boolean;
        minSeverity: string;
      }>;
    };
    // Exact objects + order: run.completed < run.failed alphabetically; within
    // run.failed, notif_target_a < notif_target_b; the foreign same-event row
    // is excluded by the JOIN on org_id.
    expect(matrix.routes).toEqual([
      {
        id: "notif_route_completed_a",
        targetId: "notif_target_a",
        eventName: "run.completed",
        enabled: true,
        minSeverity: "info",
      },
      {
        id: "notif_route_failed_a",
        targetId: "notif_target_a",
        eventName: "run.failed",
        enabled: true,
        minSeverity: "info",
      },
      {
        id: "notif_route_failed_b",
        targetId: "notif_target_b",
        eventName: "run.failed",
        enabled: true,
        minSeverity: "info",
      },
    ]);
    // The collapsed matrix read issues a SINGLE org-scoped routes query
    // through the JOIN (no N+1 listForTarget fan-out).
    const routeQueries = pool.queries.filter(({ sql }) => sql.includes("FROM notification_routes"));
    expect(routeQueries).toHaveLength(1);
    expect(routeQueries[0]?.sql).toContain("JOIN notification_targets t ON r.target_id = t.id");
    expect(routeQueries[0]?.sql).toContain("WHERE t.org_id = $1");
    expect(routeQueries[0]?.params).toEqual(["org_acme"]);
  });

  it("rejects a foreign org with 403 before any route or target store query fires", async () => {
    const { app, pool } = harness();
    // Seed a real org_acme target + route so the test fails loudly if the
    // access guard ever leaks past the actor check: the Promise.all below
    // would then issue both a route-store and a target-store query against
    // org_intruder and return [] [] (a false-403 "pass" on data the actor
    // cannot read).
    pool.targets.set("notif_target_acme", {
      id: "notif_target_acme",
      org_id: "org_acme",
      scope: "org",
      user_id: null,
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/acme",
      label: "acme",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });
    pool.routes.set("notif_route_acme", {
      id: "notif_route_acme",
      target_id: "notif_target_acme",
      event_name: "run.failed",
      enabled: 1,
      min_severity: "info",
      created_at: pool.now,
      updated_at: pool.now,
    });
    const queriesBefore = pool.queries.length;
    const res = await app.request("/orgs/org_intruder/notifications/matrix");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org_access_denied" });
    // The 403 short-circuits the Promise.all: neither the route store nor
    // the target store is queried for a foreign org.
    expect(pool.queries.length).toBe(queriesBefore);
    expect(pool.queries.filter(({ sql }) => sql.includes("FROM notification_routes"))).toHaveLength(0);
    expect(pool.queries.filter(({ sql }) => sql.includes("FROM notification_targets"))).toHaveLength(0);
  });
});
