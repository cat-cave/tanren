// (additive HTTP surface over): contract tests for the
// notifications routes the dashboard consumes. Reuses the in-memory
// notification pg substitute. Validates the matrix payload shape, target +
// route creation, the cross-org guard on route creation, and that the event
// catalog carries a default severity for every event.

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

  it("echoes a per-org base_url on a created ntfy target (API mirrors UX)", async () => {
    const { app } = harness();
    const create = await app.request("/orgs/org_acme/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelKind: "ntfy",
        destination: "cat-cave",
        baseUrl: "https://ntfy.acme.example",
        label: "alerts",
      }),
    });
    expect(create.status).toBe(201);
    const target = (await create.json()) as { baseUrl: string | null };
    expect(target.baseUrl).toBe("https://ntfy.acme.example");
  });

  it("rejects a non-URL base_url with 400 (no wrong-host route can be persisted)", async () => {
    const { app } = harness();
    const create = await app.request("/orgs/org_acme/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channelKind: "ntfy",
        destination: "cat-cave",
        baseUrl: "ntfy.acme.example",
        label: "alerts",
      }),
    });
    expect(create.status).toBe(400);
    const body = (await create.json()) as { error: string };
    expect(body.error).toBe("invalid_target");
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

  it("patches weekendMute on an existing target and reflects it in the matrix", async () => {
    const { app } = harness();
    const created = (await (
      await app.request("/orgs/org_acme/notifications/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelKind: "ntfy",
          destination: "https://ntfy.sh/quiet",
          label: "quiet-alerts",
          weekendMute: false,
        }),
      })
    ).json()) as { id: string; weekendMute: boolean };
    expect(created.weekendMute).toBe(false);

    const patch = await app.request(`/orgs/org_acme/notifications/targets/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekendMute: true }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { weekendMute: boolean; enabled: boolean; label: string };
    expect(updated.weekendMute).toBe(true);
    expect(updated.enabled).toBe(true);
    expect(updated.label).toBe("quiet-alerts");

    const matrix = (await (await app.request("/orgs/org_acme/notifications/matrix")).json()) as {
      targets: Array<{ id: string; weekendMute: boolean }>;
    };
    expect(matrix.targets.find((t) => t.id === created.id)?.weekendMute).toBe(true);
  });

  it("rejects empty quiet-posture patch and cross-org target updates", async () => {
    const { app } = harness();
    const created = (await (
      await app.request("/orgs/org_acme/notifications/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelKind: "ntfy", destination: "https://ntfy.sh/x", label: "x" }),
      })
    ).json()) as { id: string };

    const empty = await app.request(`/orgs/org_acme/notifications/targets/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe("invalid_target_update");

    const crossOrg = await app.request(`/orgs/org_other/notifications/targets/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekendMute: true }),
    });
    // Actor cannot access org_other → 403 (org guard) rather than leaking existence.
    expect(crossOrg.status).toBe(403);
  });

  it("patches enabled (pause) on an existing target", async () => {
    const { app } = harness();
    const created = (await (
      await app.request("/orgs/org_acme/notifications/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelKind: "ntfy", destination: "https://ntfy.sh/pause", label: "pause-me" }),
      })
    ).json()) as { id: string; enabled: boolean };
    expect(created.enabled).toBe(true);

    const patch = await app.request(`/orgs/org_acme/notifications/targets/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it("refuses patching another actor's user-scoped target", async () => {
    const { app, pool } = harness();
    pool.targets.set("notif_target_bob", {
      id: "notif_target_bob",
      org_id: "org_acme",
      scope: "user",
      user_id: "user_bob",
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/bob",
      label: "bob override",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });

    const patch = await app.request("/orgs/org_acme/notifications/targets/notif_target_bob", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weekendMute: true }),
    });
    // 404 (not 403) so we do not leak existence of another user's override.
    expect(patch.status).toBe(404);
    expect(((await patch.json()) as { error: string }).error).toBe("target_not_found");
  });

  it("refuses creating a route on another actor's user-scoped target", async () => {
    const { app, pool } = harness();
    pool.targets.set("notif_target_bob", {
      id: "notif_target_bob",
      org_id: "org_acme",
      scope: "user",
      user_id: "user_bob",
      channel_kind: "ntfy",
      destination: "https://ntfy.sh/bob",
      label: "bob override",
      enabled: 1,
      weekend_mute: 0,
      created_at: pool.now,
      updated_at: pool.now,
    });

    const route = await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: "notif_target_bob",
        eventName: "run.failed",
        minSeverity: "fail",
        enabled: true,
      }),
    });
    expect(route.status).toBe(404);
    expect(((await route.json()) as { error: string }).error).toBe("target_not_found");
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
        org_id: "org_acme",
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
        org_id: "org_other",
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
        org_id: "org_other",
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
    // Only org_acme's own row (id 1) is visible: the two org_other rows — including
    // the mismatched-tenant row whose targetId points at an acme target — stay
    // hidden. `notifications.org_id` is NOT NULL (0045), so there is no legacy
    // unstamped (tenant_id NULL) row resolved via the target join anymore.
    expect(body.deliveries.map((delivery) => delivery.id)).toEqual([1]);
    expect(body.deliveries[0]).toMatchObject({
      eventName: "run.failed",
      target: {
        label: "acme alerts",
        channelKind: "ntfy",
      },
      title: "Run failed",
    });
    expect(body.deliveries[0]?.target.destination).toBeUndefined();
    expect(body.deliveries[0]?.token).toBeUndefined();
    expect(body.deliveries[0]?.payload).toBeUndefined();
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

  // Codex H3 Surface 6 #18: ban stub-in-prod routing. When the boot supplies
  // the wired-channel set to the route-write endpoint, a POST that names a
  // target whose channelKind is NOT wired must be rejected — otherwise the
  // route would silently drop fail-severity escalations via a StubChannel
  // no-op publish.
  it("rejects a route to an unwired channel when wiredChannelKinds is provided", async () => {
    // ntfy is the only wired kind in this harness. Create a target on `teams`
    // (unwired) and attempt to route to it.
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
    const res = await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "notif_target_teams", eventName: "run.failed" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; channelKind: string };
    expect(body.error).toBe("channel_not_wired");
    expect(body.channelKind).toBe("teams");
  });

  it("accepts a route to a wired channel when wiredChannelKinds is provided", async () => {
    const { app } = harness(actor, new Set(["ntfy"] as const));
    const target = (await (
      await app.request("/orgs/org_acme/notifications/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelKind: "ntfy", destination: "https://ntfy.sh/x", label: "x" }),
      })
    ).json()) as { id: string };
    const res = await app.request("/orgs/org_acme/notifications/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: target.id, eventName: "run.failed", minSeverity: "fail" }),
    });
    expect(res.status).toBe(201);
  });
});
