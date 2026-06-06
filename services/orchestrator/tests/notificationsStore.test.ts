import { describe, expect, it } from "vitest";
import {
  NotificationRouteStore,
  NotificationTargetStore,
  NotificationDispatchLog,
} from "../src/engine/notifications/index.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

// Store-layer unit tests: row decode (integer/boolean coercion for enabled +
// weekendMute), the qualified-column join for listForOrgEvent, and the
// dispatch-log writer's parameter shape. Drives the real store through a
// SQL-pattern-matching memory client and asserts the decoded rows + emitted
// SQL/params, not spies.

describe("NotificationTargetStore decode", () => {
  it("coerces enabled=1 / weekend_mute=1 integers to true", async () => {
    const client = new NotificationMemoryClient();
    const created = await NotificationTargetStore.create(client, {
      id: "t1",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
      enabled: true,
      weekendMute: true,
    });
    expect(created.enabled).toBe(true);
    expect(created.weekendMute).toBe(true);
    // Stored as integer 1 (the INSERT params encode booleans as 1/0).
    expect(client.targets.get("t1")!.enabled).toBe(1);
    expect(client.targets.get("t1")!.weekend_mute).toBe(1);
  });

  it("coerces enabled=0 / weekend_mute=0 integers to false on read-back", async () => {
    const client = new NotificationMemoryClient();
    await NotificationTargetStore.create(client, {
      id: "t2",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
      enabled: false,
      weekendMute: false,
    });
    const got = await NotificationTargetStore.get(client, "t2");
    expect(got?.enabled).toBe(false);
    expect(got?.weekendMute).toBe(false);
  });

  it("decodes raw boolean true (not just integer 1) for enabled", async () => {
    const client = new NotificationMemoryClient();
    // Simulate a Postgres driver that returns native booleans.
    client.targets.set("t3", {
      id: "t3",
      org_id: "org_1",
      scope: "org",
      user_id: null,
      channel_kind: "ntfy",
      destination: "topic",
      label: "lbl",
      enabled: true,
      weekend_mute: false,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-01-01T00:00:00Z"),
    });
    const got = await NotificationTargetStore.get(client, "t3");
    expect(got?.enabled).toBe(true);
    expect(got?.weekendMute).toBe(false);
  });

  it("returns undefined for a missing target id", async () => {
    const client = new NotificationMemoryClient();
    expect(await NotificationTargetStore.get(client, "nope")).toBeUndefined();
  });
});

describe("NotificationRouteStore", () => {
  it("decodes enabled from an integer and lists routes for an org+event via the qualified join", async () => {
    const client = new NotificationMemoryClient();
    await NotificationTargetStore.create(client, {
      id: "t1",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
      enabled: true,
      weekendMute: false,
    });
    const created = await NotificationRouteStore.create(client, {
      id: "r1",
      targetId: "t1",
      eventName: "run.failed",
      enabled: true,
      minSeverity: "warn",
    });
    expect(created.enabled).toBe(true);
    expect(created.minSeverity).toBe("warn");

    const rows = await NotificationRouteStore.listForOrgEvent(client, {
      orgId: "org_1",
      eventName: "run.failed",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBe("t1");
    // The join query must prefix every selected column with the `r.` alias so
    // the route columns are unambiguous against the joined targets table.
    const joinQuery = client.queries.find((q) => q.sql.includes("FROM notification_routes r"))!;
    expect(joinQuery.sql).toContain("r.id");
    expect(joinQuery.sql).toContain("r.event_name");
    expect(joinQuery.sql).toContain("r.min_severity");
  });

  it("does not return a route whose event name differs from the query", async () => {
    const client = new NotificationMemoryClient();
    await NotificationTargetStore.create(client, {
      id: "t1",
      orgId: "org_1",
      scope: "org",
      userId: null,
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
      enabled: true,
      weekendMute: false,
    });
    await NotificationRouteStore.create(client, {
      id: "r1",
      targetId: "t1",
      eventName: "ci.failed",
      enabled: true,
      minSeverity: "info",
    });
    const rows = await NotificationRouteStore.listForOrgEvent(client, {
      orgId: "org_1",
      eventName: "run.failed",
    });
    expect(rows).toHaveLength(0);
  });
});

describe("NotificationDispatchLog", () => {
  it("writes the channel/status/attempts/sentAt and JSON-encodes the payload", async () => {
    const client = new NotificationMemoryClient();
    const sentAt = new Date("2026-01-05T12:00:00Z");
    await NotificationDispatchLog.record(client, {
      orgId: "org_1",
      channel: "ntfy",
      payload: { eventName: "run.failed", title: "x" },
      status: "sent",
      attempts: 1,
      sentAt,
    });
    const insert = client.queries.find((q) => q.sql.includes("INSERT INTO notifications"))!;
    expect(insert.params[0]).toBe("ntfy");
    // payload is JSON.stringify'd before insert.
    expect(insert.params[1]).toBe(JSON.stringify({ eventName: "run.failed", title: "x" }));
    expect(insert.params[2]).toBe("sent");
    expect(insert.params[3]).toBe(1);
    expect(insert.params[4]).toBe(sentAt);
    expect(insert.params[5]).toBe("org_1");
    expect(client.dispatches[0]?.tenant_id).toBe("org_1");
  });

  it("rejects dispatch log writes without an org id", async () => {
    const client = new NotificationMemoryClient();
    await expect(
      NotificationDispatchLog.record(client, {
        orgId: "",
        channel: "ntfy",
        payload: { eventName: "run.failed", title: "x" },
        status: "sent",
        attempts: 1,
        sentAt: null,
      }),
    ).rejects.toThrow("notification dispatch log requires an orgId");
  });
});
