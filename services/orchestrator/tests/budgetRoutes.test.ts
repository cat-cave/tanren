// Route tests for the per-project + org-default dollar-budget surface
// (autonomy-engine.md §3 proof 6). Drives the REAL project/org route handlers
// against the in-memory RoutesPool:
//   - GET  /:orgId/projects/:projectId/budget → ceiling/spent/remaining/paused;
//   - PUT  sets the project budget (read-back reflects it; cleared ⇒ unlimited);
//   - PUT  org-default budget (set → read-back), inherited by a project;
//   - the cost-sum drives `spentUsd`/`paused`/`remainingUsd`.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOrgRoutes } from "../src/routes/orgs/index.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness() {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", "user_alice", "admin");
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return admin;
        },
      } as never,
      localDevActor: admin,
    }),
  );
  // `secrets`/`vcsProvider` are only used by the greenfield create path, never by
  // the budget routes — stubbed for construction only.
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, vcsProvider: {} as never }));
  app.route("/orgs", createOrgRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

// No auth header — the harness's `localDevActor` binds the admin actor (mirrors
// the org-config gate route tests). A Bearer header would trigger token validation.
async function getJson(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function putJson(
  app: Hono<ActorContextEnv>,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("project budget routes", () => {
  it("reads an unlimited budget when none is configured", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(status).toBe(200);
    expect(body.ceilingUsd).toBeNull();
    expect(body.remainingUsd).toBeNull();
    expect(body.paused).toBe(false);
    expect(body.spentUsd).toBe(0);
    // The view always names the gated figure (real spend) + carries notional.
    expect(body.gatedFigure).toBe("real_spend");
    expect(body.notionalUsd).toBe(0);
  });

  it("surfaces notional alongside real spend, and names the gated figure (real spend)", async () => {
    const { app, pool } = buildHarness();
    // A subscription-style project: NO real spend but a notional (api-equivalent)
    // value lands on the notional axis.
    pool.seedCostRecord("proj_1", 0, 12);
    pool.seedCostRecord("proj_1", 0, 8);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });

    const { body } = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    // Real spend is $0 (the gated figure) — the ceiling is not reached.
    expect(body.spentUsd).toBe(0);
    expect(body.paused).toBe(false);
    // But the notional / equivalent figure is surfaced (never called "spend").
    expect(body.notionalUsd).toBe(20);
    expect(body.gatedFigure).toBe("real_spend");
    // Headroom is measured against the GATED figure (real spend), not notional.
    expect(body.remainingUsd).toBe(50);
  });

  it("accepts quarterly + annual periods and a gatedFigure label without a migration", async () => {
    const { app } = buildHarness();
    const q = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 200, period: "quarterly" });
    expect(q.status).toBe(200);
    expect(q.body.period).toBe("quarterly");

    const a = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", {
      ceilingUsd: 500,
      period: "annual",
      gatedFigure: "real_spend",
    });
    expect(a.status).toBe(200);
    expect(a.body.period).toBe("annual");
    expect(a.body.gatedFigure).toBe("real_spend");
  });

  it("sets a project budget and the read-back reflects it", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "monthly" });
    expect(put.status).toBe(200);
    expect(put.body.ceilingUsd).toBe(50);
    expect(put.body.period).toBe("monthly");

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.body.ceilingUsd).toBe(50);
    expect(get.body.remainingUsd).toBe(50);
    expect(get.body.paused).toBe(false);
  });

  it("defaults the period to monthly when omitted on PUT", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 25 });
    expect(put.status).toBe(200);
    expect(put.body.period).toBe("monthly");
  });

  it("reports spend, remaining, and pause when spend reaches the ceiling", async () => {
    const { app, pool } = buildHarness();
    // 30 + 25 = 55 total spend ≥ the 50 ceiling.
    pool.seedCostRecord("proj_1", 30);
    pool.seedCostRecord("proj_1", 25);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.body.spentUsd).toBe(55);
    expect(get.body.remainingUsd).toBe(0);
    expect(get.body.paused).toBe(true);
  });

  it("clearing the ceiling (null) returns to unlimited", async () => {
    const { app } = buildHarness();
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50 });
    const cleared = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.ceilingUsd).toBeNull();

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.body.ceilingUsd).toBeNull();
    expect(get.body.paused).toBe(false);
  });

  it("a project inherits the org-default budget when it sets none", async () => {
    const { app } = buildHarness();
    // Set the org default; the project has no budget of its own ⇒ it inherits.
    const orgPut = await putJson(app, "/orgs/org_acme/budget", { ceilingUsd: 100, period: "monthly" });
    expect(orgPut.status).toBe(200);
    expect(orgPut.body.ceilingUsd).toBe(100);

    const orgGet = await getJson(app, "/orgs/org_acme/budget");
    expect(orgGet.body.ceilingUsd).toBe(100);

    const projGet = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(projGet.body.ceilingUsd).toBe(100);
  });

  it("a project's own budget overrides the org default", async () => {
    const { app } = buildHarness();
    await putJson(app, "/orgs/org_acme/budget", { ceilingUsd: 100 });
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 10 });
    const projGet = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(projGet.body.ceilingUsd).toBe(10);
  });

  it("rejects a negative ceiling", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: -5 });
    expect(put.status).toBe(400);
  });

  it("404s an unknown project", async () => {
    const { app } = buildHarness();
    const { status } = await getJson(app, "/orgs/org_acme/projects/nope/budget");
    expect(status).toBe(404);
  });
});
