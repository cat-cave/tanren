// Loop 5 — onboarding seeds a per-org DEFAULT notification route so the
// apex-critical milestone events reach a human BY DEFAULT (api-mirrors-ux): a
// freshly-onboarded org already has a dashboard-visible ntfy target + a warn-floor
// route for each milestone event, without an operator hand-configuring the matrix.
// These prove: the seed creates the target + the milestone routes; it is
// idempotent (a re-onboard adds nothing); and a budget-milestone/deploy.verified
// event would match the seeded org route (the matrix finds it).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  ensureDefaultNotificationRoute,
  DEFAULT_ROUTE_EVENTS,
  DEFAULT_ROUTE_TARGET_LABEL,
  evaluateMatrix,
  NotificationRouteStore,
  NotificationTargetStore,
} from "../src/engine/notifications/index.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

// Wrap the SQL-pattern-matching memory client as a connect-able pool so
// `runWithOrgScope` (BEGIN / SET LOCAL / COMMIT + the work client) drives it. The
// transaction-control statements hit the memory client's no-op default branch.
function poolFor(client: NotificationMemoryClient): pg.Pool {
  const query = (sql: string, params: ReadonlyArray<unknown> = []) => {
    const trimmed = sql.trim();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed.startsWith("SET LOCAL")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return client.query(sql, params);
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

describe("ensureDefaultNotificationRoute (Loop 5 onboarding seed)", () => {
  it("seeds a per-org ntfy target + a route for every milestone event", async () => {
    const client = new NotificationMemoryClient();
    const pool = poolFor(client);
    const result = await ensureDefaultNotificationRoute({ pool, orgId: "org_a", ntfyTopic: "tanren-org-org_a" });

    expect(result.created).toBe(true);
    expect(result.target.channelKind).toBe("ntfy");
    expect(result.target.scope).toBe("org");
    expect(result.target.destination).toBe("tanren-org-org_a");
    expect(result.target.label).toBe(DEFAULT_ROUTE_TARGET_LABEL);
    // One warn-floor route per apex-critical milestone event.
    expect(result.routes).toHaveLength(DEFAULT_ROUTE_EVENTS.length);
    expect(new Set(result.routes.map((r) => r.eventName))).toEqual(new Set(DEFAULT_ROUTE_EVENTS));
    expect(result.routes.every((r) => r.minSeverity === "warn")).toBe(true);
  });

  // Pin the two operator-actionable failure events (PR #742 `demo.failed`, PR
  // #754 `usage.accounting_failed`) into the seeded default matrix. A regression
  // that drops either from `DEFAULT_ROUTE_EVENTS` would silently strand the
  // apex-critical failure off the per-org matrix and only surface via the
  // env-default belt-and-suspenders — this test is the guard.
  it("the seed pins the operator-actionable demo/accounting failures on the matrix", async () => {
    expect(new Set(DEFAULT_ROUTE_EVENTS)).toContain("demo.failed");
    expect(new Set(DEFAULT_ROUTE_EVENTS)).toContain("usage.accounting_failed");
    const client = new NotificationMemoryClient();
    const pool = poolFor(client);
    const result = await ensureDefaultNotificationRoute({ pool, orgId: "org_a", ntfyTopic: "tanren-org-org_a" });
    const eventNames = new Set(result.routes.map((r) => r.eventName));
    expect(eventNames).toContain("demo.failed");
    expect(eventNames).toContain("usage.accounting_failed");
  });

  it("is idempotent — a re-onboard reuses the target and adds no duplicate routes", async () => {
    const client = new NotificationMemoryClient();
    const pool = poolFor(client);
    const first = await ensureDefaultNotificationRoute({ pool, orgId: "org_a", ntfyTopic: "tanren-org-org_a" });
    const second = await ensureDefaultNotificationRoute({ pool, orgId: "org_a", ntfyTopic: "tanren-org-org_a" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.target.id).toBe(first.target.id);
    // No second target, no duplicate routes.
    expect(client.targets.size).toBe(1);
    expect(client.routes.size).toBe(DEFAULT_ROUTE_EVENTS.length);
  });

  it("the seeded org route MATCHES a budget-milestone / deploy.verified event in the matrix", async () => {
    const client = new NotificationMemoryClient();
    const pool = poolFor(client);
    await ensureDefaultNotificationRoute({ pool, orgId: "org_a", ntfyTopic: "tanren-org-org_a" });

    for (const eventName of ["dag.budget.milestone", "deploy.verified"]) {
      const targets = await NotificationTargetStore.listForOrg(client as unknown as pg.Pool, "org_a");
      const routes = await NotificationRouteStore.listForOrgEvent(client as unknown as pg.Pool, {
        orgId: "org_a",
        eventName,
      });
      const matches = evaluateMatrix({
        targets,
        routes,
        actorUserId: null,
        eventName,
        // `warn` is the milestone events' effective severity — clears the warn floor.
        effectiveSeverity: "warn",
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.target.destination).toBe("tanren-org-org_a");
    }
  });
});
