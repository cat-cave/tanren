import { describe, expect, it } from "vitest";
import {
  NotificationPayload,
  NotificationRouteCreateInput,
  NotificationRouteRow,
  NotificationTargetCreateInput,
  NotificationTargetRow,
  severityMeetsFloor,
  severityRank,
} from "../src/engine/notifications/index.js";

// Schema validation tests: the scope/userId cross-field refinements, the
// min-length and default rules, and the severity-rank ordering. These pin the
// observable parse outcomes (accept vs reject + which path the issue is on).

function baseTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "t",
    orgId: "org",
    scope: "org",
    userId: null,
    channelKind: "ntfy",
    destination: "topic",
    baseUrl: null,
    label: "lbl",
    enabled: true,
    weekendMute: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("NotificationTargetRow refinement", () => {
  it("accepts an org-scoped row with a null userId", () => {
    expect(NotificationTargetRow.safeParse(baseTarget()).success).toBe(true);
  });

  it("rejects an org-scoped row that carries a userId, flagging the userId path", () => {
    const result = NotificationTargetRow.safeParse(baseTarget({ scope: "org", userId: "user_1" }));
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["userId"]);
    expect(result.success === false && result.error.issues[0]?.message).toMatch(/null userId/u);
  });

  it("accepts a user-scoped row with a non-null userId", () => {
    expect(NotificationTargetRow.safeParse(baseTarget({ scope: "user", userId: "user_1" })).success).toBe(true);
  });

  it("rejects a user-scoped row with a null userId, flagging the userId path", () => {
    const result = NotificationTargetRow.safeParse(baseTarget({ scope: "user", userId: null }));
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["userId"]);
    expect(result.success === false && result.error.issues[0]?.message).toMatch(/non-null userId/u);
  });

  it("rejects an empty id / orgId / destination / label", () => {
    expect(NotificationTargetRow.safeParse(baseTarget({ id: "" })).success).toBe(false);
    expect(NotificationTargetRow.safeParse(baseTarget({ orgId: "" })).success).toBe(false);
    expect(NotificationTargetRow.safeParse(baseTarget({ destination: "" })).success).toBe(false);
    expect(NotificationTargetRow.safeParse(baseTarget({ label: "" })).success).toBe(false);
  });

  // audit C4 / RC-1: a per-target base_url is an http(s) URL or null; a bare
  // host (a non-URL) is rejected so a wrong-host route can never be persisted.
  it("accepts a null base_url (use the deploy default)", () => {
    const result = NotificationTargetRow.safeParse(baseTarget({ baseUrl: null }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.baseUrl).toBeNull();
  });

  it("accepts an http(s) URL base_url", () => {
    expect(NotificationTargetRow.safeParse(baseTarget({ baseUrl: "https://tenant.ntfy.example" })).success).toBe(true);
  });

  it("rejects a non-URL base_url (a bare host or empty string)", () => {
    expect(NotificationTargetRow.safeParse(baseTarget({ baseUrl: "ntfy.example" })).success).toBe(false);
    expect(NotificationTargetRow.safeParse(baseTarget({ baseUrl: "" })).success).toBe(false);
  });
});

describe("NotificationTargetCreateInput refinement + defaults", () => {
  it("defaults userId to null, enabled to true, weekendMute to false", () => {
    const parsed = NotificationTargetCreateInput.parse({
      orgId: "org",
      scope: "org",
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
    });
    expect(parsed.userId).toBeNull();
    expect(parsed.enabled).toBe(true);
    expect(parsed.weekendMute).toBe(false);
  });

  it("rejects an org-scoped create input that carries a userId", () => {
    const result = NotificationTargetCreateInput.safeParse({
      orgId: "org",
      scope: "org",
      userId: "user_1",
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["userId"]);
  });

  it("rejects a user-scoped create input with a null userId", () => {
    const result = NotificationTargetCreateInput.safeParse({
      orgId: "org",
      scope: "user",
      userId: null,
      channelKind: "ntfy",
      destination: "topic",
      label: "lbl",
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.path).toEqual(["userId"]);
  });
});

describe("NotificationRoute schemas", () => {
  it("defaults route enabled to true and minSeverity to info", () => {
    const parsed = NotificationRouteCreateInput.parse({ targetId: "t", eventName: "run.failed" });
    expect(parsed.enabled).toBe(true);
    expect(parsed.minSeverity).toBe("info");
  });

  it("rejects an empty targetId or eventName on a route row", () => {
    const base = {
      id: "r",
      targetId: "t",
      eventName: "run.failed",
      enabled: true,
      minSeverity: "info" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(NotificationRouteRow.safeParse({ ...base, targetId: "" }).success).toBe(false);
    expect(NotificationRouteRow.safeParse({ ...base, eventName: "" }).success).toBe(false);
    expect(NotificationRouteRow.safeParse(base).success).toBe(true);
  });
});

describe("NotificationPayload schema", () => {
  it("rejects an empty title but accepts an empty body", () => {
    expect(
      NotificationPayload.safeParse({ title: "", body: "", severity: "ok", eventName: "run.completed" }).success,
    ).toBe(false);
    expect(
      NotificationPayload.safeParse({ title: "t", body: "", severity: "ok", eventName: "run.completed" }).success,
    ).toBe(true);
  });
});

describe("severity ordering", () => {
  it("ranks ok < info < warn < fail", () => {
    expect(severityRank("ok")).toBeLessThan(severityRank("info"));
    expect(severityRank("info")).toBeLessThan(severityRank("warn"));
    expect(severityRank("warn")).toBeLessThan(severityRank("fail"));
  });

  it("meets the floor only at or above it", () => {
    expect(severityMeetsFloor("info", "info")).toBe(true);
    expect(severityMeetsFloor("warn", "info")).toBe(true);
    expect(severityMeetsFloor("ok", "info")).toBe(false);
  });
});
