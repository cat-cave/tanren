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
import { PgBudgetPauseObservationReader } from "../src/engine/dag/budgetPauseObservation.js";
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
  // `secrets`/`githubHttp` are only used by the greenfield create path, never by
  // the budget routes — stubbed for construction only.
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
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
    // The view carries notional alongside real spend (the gated figure is always real).
    expect(body.notionalUsd).toBe(0);
  });

  it("surfaces notional alongside real spend (the ceiling always gates real spend)", async () => {
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
    // Headroom is measured against the GATED figure (real spend), not notional.
    expect(body.remainingUsd).toBe(50);
  });

  it("accepts quarterly + annual periods without a migration", async () => {
    const { app } = buildHarness();
    const q = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 200, period: "quarterly" });
    expect(q.status).toBe(200);
    expect(q.body.period).toBe("quarterly");

    const a = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", {
      ceilingUsd: 500,
      period: "annual",
    });
    expect(a.status).toBe(200);
    expect(a.body.period).toBe("annual");
  });

  it("REJECTS the deleted `gatedFigure` knob loudly (strict schema) — real-spend is the only doctrine", async () => {
    const { app } = buildHarness();
    // The gate ALWAYS sums real spend; there is no "which figure" mode to configure.
    // A request carrying the removed field must fail loud, never silently no-op.
    const res = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", {
      ceilingUsd: 500,
      period: "annual",
      gatedFigure: "real_spend",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_budget");
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
    // The budget state may reach the ceiling before the next walker tick. Never
    // fabricate a zero-held proof while no durable pause event exists.
    expect(get.body.pauseObservation).toBeNull();
  });

  it("surfaces the latest org-scoped truthful held-ready pause proof", async () => {
    const { app, pool } = buildHarness();
    pool.seedCostRecord("proj_1", 55);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });

    // A same-project event stamped with another org must never leak through the
    // org-scoped projection.
    pool.seedBudgetPause({ orgId: "org_other", projectId: "proj_1", readyHeldBack: 99 });
    const crossOrgOnly = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(crossOrgOnly.body.pauseObservation).toBeNull();

    pool.seedBudgetPause({
      orgId: "org_acme",
      projectId: "proj_1",
      readyHeldBack: 2,
      observedAt: new Date("2026-07-15T13:14:15.000Z"),
    });
    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.status).toBe(200);
    expect(get.body.pauseObservation).toEqual({
      eventType: "dag.budget.paused",
      readyHeldBack: 2,
      observedAt: "2026-07-15T13:14:15.000Z",
    });
  });

  it("selects the WALKER event over a newer same-org/task-loop pause (run-scoped events never shadow it)", async () => {
    // GV-5 finding #2: a task-loop `dag.budget.paused` carries non-null task/run/spec
    // identity. The observation projection is the PROJECT-LEVEL walker proof
    // (run_id/task_id/spec_id IS NULL), so a NEWER run-scoped pause must never
    // shadow an OLDER walker event. Exercises the real SQL filter shape, not a helper.
    const { app, pool } = buildHarness();
    pool.seedCostRecord("proj_1", 55);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });

    // OLDER walker proof (project-level: null ids) — the canonical observation.
    pool.seedBudgetPause({
      orgId: "org_acme",
      projectId: "proj_1",
      readyHeldBack: 2,
      observedAt: new Date("2026-07-15T12:00:00.000Z"),
    });
    // NEWER task-loop pause (run-scoped: non-null ids) stamped on the SAME org/project.
    pool.seedBudgetPause({
      orgId: "org_acme",
      projectId: "proj_1",
      readyHeldBack: 99,
      observedAt: new Date("2026-07-15T23:59:59.000Z"),
      runId: "run_loop",
      taskId: "task_loop",
      specId: "spec_loop",
    });

    const reader = new PgBudgetPauseObservationReader(pool.asPgPool());
    const observation = await reader.latest("org_acme", "proj_1");
    // The walker event (readyHeldBack 2) wins; the newer run-scoped 99 is filtered out.
    expect(observation).toMatchObject({ eventType: "dag.budget.paused", readyHeldBack: 2 });

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.body.pauseObservation).toMatchObject({ readyHeldBack: 2 });
    expect(get.body.pauseObservation).not.toMatchObject({ readyHeldBack: 99 });
  });

  it("a malformed pause PAYLOAD fails LOUD at the decoder boundary (never a silent null observation)", async () => {
    // GV-5 finding #3: a corrupt historical row must not become a fabricated zero/no-observation.
    // The decoder re-validates the payload at the HTTP boundary and throws (fail-loud).
    const { app, pool } = buildHarness();
    pool.seedCostRecord("proj_1", 55);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });
    pool.seedBudgetPause({
      orgId: "org_acme",
      projectId: "proj_1",
      readyHeldBack: 0,
      payload: { ceilingUsd: 50, spentUsd: 55, period: "total", readyHeldBack: "not-a-number" },
    });

    const reader = new PgBudgetPauseObservationReader(pool.asPgPool());
    await expect(reader.latest("org_acme", "proj_1")).rejects.toThrow(/expected|invalid/iu);

    // Route consequence: the budget GET fails LOUD (500) rather than returning a
    // silent 200 with a null/fabricated observation.
    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(get.status).toBe(500);
    // No budget view rendered — never a silent observation.
    expect(get.body).toBeNull();
  });

  it("a malformed pause TIMESTAMP fails LOUD at the decoder boundary", async () => {
    // GV-5 finding #3: an invalid timestamp must throw at the decoder, never silently
    // degrade into a no-observation state.
    const { pool } = buildHarness();
    pool.seedBudgetPause({
      orgId: "org_acme",
      projectId: "proj_1",
      readyHeldBack: 1,
      ts: "not-an-iso-timestamp",
    });
    const reader = new PgBudgetPauseObservationReader(pool.asPgPool());
    await expect(reader.latest("org_acme", "proj_1")).rejects.toThrow(/expected|invalid|datetime/iu);
  });

  it("an invalid row shape (undecodable payload) fails LOUD at the decoder boundary", async () => {
    // GV-5 finding #3: a row whose payload cannot decode (missing/undefined) must
    // throw, never become a fabricated observation.
    const { pool } = buildHarness();
    pool.events.push({
      id: pool.events.length + 1,
      ts: new Date("2026-07-15T12:00:00.000Z"),
      run_id: null,
      task_id: null,
      spec_id: null,
      project_id: "proj_1",
      org_id: "org_acme",
      event_type: "dag.budget.paused",
      payload: undefined,
    });
    const reader = new PgBudgetPauseObservationReader(pool.asPgPool());
    await expect(reader.latest("org_acme", "proj_1")).rejects.toThrow(/expected|invalid/iu);
  });

  it("RAISING the ceiling on a PAUSED project fires a re-walk wake so it resumes (audit §3.7e)", async () => {
    // This is the resume test that FAILS without the fix: raising the ceiling persisted
    // the new budget but emitted NO NOTIFY, so the budget-paused DagWalker (driven purely
    // by the bus) stayed paused until a worker reboot. The fix fires a `tanren_dag`
    // re-walk when the write un-pauses the project.
    const { app, pool } = buildHarness();
    // 55 spend ≥ the 50 ceiling ⇒ the project is PAUSED.
    pool.seedCostRecord("proj_1", 55);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });
    const paused = await getJson(app, "/orgs/org_acme/projects/proj_1/budget");
    expect(paused.body.paused).toBe(true);
    // Ignore any wakes from the initial set.
    pool.notifies.length = 0;

    // RAISE the ceiling above the spend ⇒ the project is no longer paused.
    const raised = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 100, period: "total" });
    expect(raised.body.paused).toBe(false);

    // The un-pause fired a `tanren_dag` re-walk for THIS project (the resume mechanism).
    expect(pool.notifies).toEqual([{ channel: "tanren_dag", payload: "proj_1" }]);
  });

  it("LOWERING the ceiling on a non-paused project fires NO re-walk wake (only an un-pause does)", async () => {
    const { app, pool } = buildHarness();
    pool.seedCostRecord("proj_1", 10);
    await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 100, period: "total" });
    pool.notifies.length = 0;
    // Lower to 50 — still above the $10 spend, so it was never paused → no wake.
    const lowered = await putJson(app, "/orgs/org_acme/projects/proj_1/budget", { ceilingUsd: 50, period: "total" });
    expect(lowered.body.paused).toBe(false);
    expect(pool.notifies).toEqual([]);
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
