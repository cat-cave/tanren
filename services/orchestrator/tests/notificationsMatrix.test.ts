import { describe, expect, it } from "vitest";
import {
  evaluateMatrix,
  isWeekendInUtc,
  severityMeetsFloor,
  type NotificationRouteRow,
  type NotificationTargetRow,
} from "../src/engine/notifications/index.js";

// P2A-0017 matrix-evaluation unit tests. The matrix routes (target × route)
// pairs through the dispatcher; these tests pin the layering and severity-
// floor rules without involving channels or the database.

function target(overrides: Partial<NotificationTargetRow>): NotificationTargetRow {
  return {
    id: overrides.id ?? "target_org_ntfy",
    orgId: overrides.orgId ?? "org_1",
    scope: overrides.scope ?? "org",
    userId: overrides.userId ?? null,
    channelKind: overrides.channelKind ?? "ntfy",
    destination: overrides.destination ?? "tanren-runs",
    label: overrides.label ?? "ntfy default",
    enabled: overrides.enabled ?? true,
    weekendMute: overrides.weekendMute ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

function route(overrides: Partial<NotificationRouteRow>): NotificationRouteRow {
  return {
    id: overrides.id ?? "route_1",
    targetId: overrides.targetId ?? "target_org_ntfy",
    eventName: overrides.eventName ?? "run.failed",
    enabled: overrides.enabled ?? true,
    minSeverity: overrides.minSeverity ?? "info",
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

describe("severity floor", () => {
  it("ok floor matches every severity", () => {
    for (const sev of ["ok", "info", "warn", "fail"] as const) {
      expect(severityMeetsFloor(sev, "ok")).toBe(true);
    }
  });

  it("warn floor rejects ok and info", () => {
    expect(severityMeetsFloor("ok", "warn")).toBe(false);
    expect(severityMeetsFloor("info", "warn")).toBe(false);
    expect(severityMeetsFloor("warn", "warn")).toBe(true);
    expect(severityMeetsFloor("fail", "warn")).toBe(true);
  });

  it("fail floor only matches fail", () => {
    expect(severityMeetsFloor("warn", "fail")).toBe(false);
    expect(severityMeetsFloor("fail", "fail")).toBe(true);
  });
});

describe("evaluateMatrix", () => {
  it("returns the org default when no user override exists", () => {
    const orgTarget = target({ id: "t_org", scope: "org" });
    const routeRow = route({ targetId: "t_org" });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [routeRow],
      actorUserId: null,
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches.map((m) => m.layering)).toEqual(["org_default"]);
  });

  it("user override supersedes the org default on the same channel kind", () => {
    const orgTarget = target({ id: "t_org", scope: "org" });
    const userTarget = target({
      id: "t_user",
      scope: "user",
      userId: "user_1",
      label: "personal ntfy",
    });
    const orgRoute = route({ id: "r_org", targetId: "t_org" });
    const userRoute = route({ id: "r_user", targetId: "t_user" });
    const matches = evaluateMatrix({
      targets: [orgTarget, userTarget],
      routes: [orgRoute, userRoute],
      actorUserId: "user_1",
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches.map((m) => m.target.id)).toEqual(["t_user"]);
    expect(matches[0]?.layering).toBe("user_override");
  });

  it("user override that disables also suppresses the org default", () => {
    const orgTarget = target({ id: "t_org", scope: "org" });
    const userTarget = target({
      id: "t_user",
      scope: "user",
      userId: "user_1",
      enabled: false,
    });
    const orgRoute = route({ id: "r_org", targetId: "t_org" });
    const userRoute = route({ id: "r_user", targetId: "t_user" });
    const matches = evaluateMatrix({
      targets: [orgTarget, userTarget],
      routes: [orgRoute, userRoute],
      actorUserId: "user_1",
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches).toEqual([]);
  });

  it("a user with a different userId does not override the org default", () => {
    const orgTarget = target({ id: "t_org", scope: "org" });
    const userTarget = target({
      id: "t_user_other",
      scope: "user",
      userId: "user_other",
    });
    const orgRoute = route({ id: "r_org", targetId: "t_org" });
    const userRoute = route({ id: "r_user", targetId: "t_user_other" });
    const matches = evaluateMatrix({
      targets: [orgTarget, userTarget],
      routes: [orgRoute, userRoute],
      actorUserId: "user_1",
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches.map((m) => m.target.id)).toEqual(["t_org"]);
  });

  it("does not fire when the severity floor exceeds the event's severity", () => {
    const orgTarget = target({ id: "t_org" });
    const orgRoute = route({ targetId: "t_org", minSeverity: "fail" });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [orgRoute],
      actorUserId: null,
      eventName: "run.started",
      effectiveSeverity: "info",
    });
    expect(matches).toEqual([]);
  });

  it("a user route below the severity floor fires nothing but still suppresses the org default", () => {
    // The user has explicitly taken control of this (channelKind) pair, so the
    // org default must not fire — but the user route itself is not live because
    // its minSeverity floor exceeds the event severity.
    const orgTarget = target({ id: "t_org", scope: "org" });
    const userTarget = target({ id: "t_user", scope: "user", userId: "user_1" });
    const orgRoute = route({ id: "r_org", targetId: "t_org", minSeverity: "info" });
    const userRoute = route({ id: "r_user", targetId: "t_user", minSeverity: "fail" });
    const matches = evaluateMatrix({
      targets: [orgTarget, userTarget],
      routes: [orgRoute, userRoute],
      actorUserId: "user_1",
      eventName: "run.failed",
      effectiveSeverity: "warn", // below the user route's fail floor, above org's info floor
    });
    expect(matches).toEqual([]);
  });

  it("does not fire when the route itself is disabled even though the target is enabled", () => {
    const orgTarget = target({ id: "t_org", enabled: true });
    const orgRoute = route({ targetId: "t_org", enabled: false });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [orgRoute],
      actorUserId: null,
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches).toEqual([]);
  });

  it("fires when both target and route are enabled and the floor is met", () => {
    const orgTarget = target({ id: "t_org", enabled: true });
    const orgRoute = route({ targetId: "t_org", enabled: true, minSeverity: "warn" });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [orgRoute],
      actorUserId: null,
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches).toHaveLength(1);
  });

  it("does not fire when the target is disabled", () => {
    const orgTarget = target({ id: "t_org", enabled: false });
    const orgRoute = route({ targetId: "t_org" });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [orgRoute],
      actorUserId: null,
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches).toEqual([]);
  });

  it("returns nothing when no route matches the event name", () => {
    const orgTarget = target({ id: "t_org" });
    const orgRoute = route({ targetId: "t_org", eventName: "ci.failed" });
    const matches = evaluateMatrix({
      targets: [orgTarget],
      routes: [orgRoute],
      actorUserId: null,
      eventName: "run.failed",
      effectiveSeverity: "fail",
    });
    expect(matches).toEqual([]);
  });
});

describe("isWeekendInUtc", () => {
  it("returns true on Saturday (UTC)", () => {
    expect(isWeekendInUtc(new Date("2026-01-03T12:00:00Z"))).toBe(true);
  });

  it("returns true on Sunday (UTC)", () => {
    expect(isWeekendInUtc(new Date("2026-01-04T12:00:00Z"))).toBe(true);
  });

  it("returns false on Monday (UTC)", () => {
    expect(isWeekendInUtc(new Date("2026-01-05T12:00:00Z"))).toBe(false);
  });

  it("returns false on Friday (UTC)", () => {
    expect(isWeekendInUtc(new Date("2026-01-02T23:59:59Z"))).toBe(false);
  });
});
