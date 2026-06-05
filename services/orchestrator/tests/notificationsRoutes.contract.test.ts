// (additive HTTP surface over): contract tests for the
// notifications routes the dashboard consumes. Reuses the in-memory
// notification pg substitute. Validates the matrix payload shape, target +
// route creation, the cross-org guard on route creation, and that the event
// catalog carries a default severity for every event.

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

function harness(who: ActorContext | undefined = actor) {
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
  app.route("/orgs", createNotificationRoutes({ pool: pool as never }));
  return { app, pool };
}

describe("notifications routes (P2B-0002 over P2A-0017)", () => {
  it("returns the matrix payload with an event catalog carrying severities", async () => {
    const { app } = harness();
    const res = await app.request("/orgs/org_acme/notifications/matrix");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: unknown[];
      routes: unknown[];
      events: Array<{ eventName: string; defaultSeverity: string }>;
    };
    expect(body.targets).toEqual([]);
    expect(body.routes).toEqual([]);
    expect(body.events.length).toBeGreaterThan(0);
    // run.failed is a known event and must default to fail severity.
    const runFailed = body.events.find((e) => e.eventName === "run.failed");
    expect(runFailed?.defaultSeverity).toBe("fail");
    expect(body.events.every((e) => ["ok", "info", "warn", "fail"].includes(e.defaultSeverity))).toBe(true);
  });

  it("creates an ntfy target and lists it back in the matrix", async () => {
    const { app } = harness();
    const create = await app.request("/orgs/org_acme/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelKind: "ntfy",
        destination: "https://ntfy.sh/cat-cave",
        label: "alerts",
      }),
    });
    expect(create.status).toBe(201);
    const target = (await create.json()) as { id: string; channelKind: string; scope: string };
    expect(target.channelKind).toBe("ntfy");
    expect(target.scope).toBe("org");

    const matrix = await (await app.request("/orgs/org_acme/notifications/matrix")).json();
    expect((matrix as { targets: unknown[] }).targets).toHaveLength(1);
  });

  it("creates a route opt-in bound to a target", async () => {
    const { app } = harness();
    const target = (await (
      await app.request("/orgs/org_acme/notifications/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelKind: "ntfy", destination: "https://ntfy.sh/x", label: "x" }),
      })
    ).json()) as { id: string };

    const route = await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: target.id,
        eventName: "run.failed",
        minSeverity: "fail",
        enabled: true,
      }),
    });
    expect(route.status).toBe(201);
    const body = (await route.json()) as { eventName: string; enabled: boolean };
    expect(body.eventName).toBe("run.failed");
    expect(body.enabled).toBe(true);
  });

  it("rejects a route bound to a target in another org with 404", async () => {
    const { app, pool } = harness();
    // Seed a target owned by a different org directly in the store.
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
    const res = await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "notif_target_other", eventName: "run.failed" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects cross-org matrix access with 403", async () => {
    const { app } = harness();
    const res = await app.request("/orgs/org_intruder/notifications/matrix");
    expect(res.status).toBe(403);
  });
});
