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

  it("returns recent delivery evidence scoped to the org without raw payload values", async () => {
    const { app, pool } = harness();
    pool.targets.set("notif_target_acme", {
      id: "notif_target_acme",
      org_id: "org_acme",
      scope: "org",
      user_id: null,
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/acme",
      label: "acme alerts",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });
    pool.targets.set("notif_target_other", {
      id: "notif_target_other",
      org_id: "org_other",
      scope: "org",
      user_id: null,
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/other",
      label: "other alerts",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });
    pool.dispatches.push(
      {
        id: 1,
        tenant_id: "org_acme",
        channel: "ntfy",
        status: "sent",
        attempts: 1,
        enqueued_at: pool.now,
        sent_at: pool.now,
        payload: {
          eventName: "run.failed",
          targetId: "notif_target_acme",
          severity: "fail",
          title: "Run failed",
          token: "must-not-leak",
        },
      },
      {
        id: 2,
        tenant_id: "org_other",
        channel: "ntfy",
        status: "sent",
        attempts: 1,
        enqueued_at: pool.now,
        sent_at: pool.now,
        payload: {
          eventName: "run.failed",
          targetId: "notif_target_other",
          severity: "fail",
          title: "Other run failed",
        },
      },
      {
        id: 3,
        tenant_id: "org_other",
        channel: "ntfy",
        status: "sent",
        attempts: 1,
        enqueued_at: pool.now,
        sent_at: pool.now,
        payload: {
          eventName: "run.failed",
          targetId: "notif_target_acme",
          severity: "fail",
          title: "Mismatched tenant must stay hidden",
        },
      },
      {
        id: 4,
        tenant_id: null,
        channel: "ntfy",
        status: "sent",
        attempts: 1,
        enqueued_at: pool.now,
        sent_at: pool.now,
        payload: {
          eventName: "run.failed",
          targetId: "notif_target_acme",
          severity: "fail",
          title: "Legacy unstamped run failed",
        },
      },
    );

    const res = await app.request("/orgs/org_acme/notifications/deliveries?eventName=run.failed&status=sent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveries: Array<{
        id: number;
        eventName: string;
        target: { label: string; channelKind: string; destination?: string };
        title: string;
        token?: string;
        payload?: unknown;
      }>;
    };
    expect(body.deliveries.map((delivery) => delivery.id)).toEqual([4, 1]);
    expect(body.deliveries[0]).toMatchObject({
      eventName: "run.failed",
      target: {
        label: "acme alerts",
        channelKind: "ntfy",
      },
      title: "Legacy unstamped run failed",
    });
    expect(body.deliveries[1]).toMatchObject({
      eventName: "run.failed",
      target: {
        label: "acme alerts",
        channelKind: "ntfy",
      },
      title: "Run failed",
    });
    expect(body.deliveries[1]?.target.destination).toBeUndefined();
    expect(body.deliveries[1]?.token).toBeUndefined();
    expect(body.deliveries[1]?.payload).toBeUndefined();
  });

  it("rejects invalid delivery status filters", async () => {
    const { app } = harness();
    const res = await app.request("/orgs/org_acme/notifications/deliveries?status=queued");
    expect(res.status).toBe(400);
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
