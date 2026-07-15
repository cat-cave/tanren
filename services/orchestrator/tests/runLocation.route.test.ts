// Production-facing contract tests for GET /orgs/:orgId/runs/:runId/location.
// Covers org-bind (including privileged actors), exact SQL params, and the
// indistinguishable 404 surface for missing / cross-org / project-denied runs.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { RunLocation } from "../src/routes/runs/contract.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const platformAdmin: ActorContext = {
  userId: "user_platform",
  orgId: "org_platform",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function buildHarness(actor: ActorContext | undefined = alice) {
  const pool = new RunRoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor as ActorContext;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

function seedVisibleRun(pool: RunRoutesPool, runId = "run_fixture") {
  const projectId = "project_phase1";
  const specId = "spec_phase1";
  pool.seedProject({ project_id: projectId, org_id: "org_acme" });
  pool.seedSpec({ spec_id: specId, project_id: projectId, title: "Add fixture marker" });
  pool.seedRun({
    run_id: runId,
    spec_id: specId,
    project_id: projectId,
    org_id: "org_acme",
    status: "completed",
    outcome: "ok",
  });
  return { runId, projectId };
}

function runSummaryQueries(pool: RunRoutesPool) {
  return pool.queries.filter(({ sql }) => /FROM runs WHERE run_id = \$1 AND org_id = \$2/u.test(sql.trim()));
}

describe("GET /orgs/:orgId/runs/:runId/location", () => {
  it("returns only orgId+projectId with exact bound SQL params and no list fan-out", async () => {
    const { app, pool } = buildHarness();
    const { runId, projectId } = seedVisibleRun(pool);
    const response = await app.request(`/orgs/org_acme/runs/${runId}/location`);

    expect(response.status).toBe(200);
    expect(RunLocation.parse(await response.json())).toEqual({ orgId: "org_acme", projectId });

    const summaries = runSummaryQueries(pool);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.params).toEqual([runId, "org_acme"]);
    expect(pool.queries.some(({ sql }) => /FROM runs/u.test(sql) && /project_id = \$1/u.test(sql))).toBe(false);
  });

  it("rejects an unauthorized addressed org without querying the run", async () => {
    const { app, pool } = buildHarness({ ...alice, orgId: "org_other" });
    const { runId } = seedVisibleRun(pool);

    const response = await app.request(`/orgs/org_acme/runs/${runId}/location`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "org_access_denied" });
    expect(pool.queries).toEqual([]);
  });

  it("returns the same 404 body for absent and cross-org runs", async () => {
    const { app, pool } = buildHarness();
    pool.seedProject({ project_id: "project_other", org_id: "org_other" });
    pool.seedSpec({ spec_id: "spec_other", project_id: "project_other" });
    pool.seedRun({
      run_id: "run_other",
      spec_id: "spec_other",
      project_id: "project_other",
      org_id: "org_other",
    });

    for (const runId of ["run_missing", "run_other"]) {
      const response = await app.request(`/orgs/org_acme/runs/${runId}/location`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "run_not_found" });
    }
  });

  it("folds a project access denial into the same 404 response", async () => {
    class ProjectDeniedPool extends RunRoutesPool {
      override async query(sql: string, params: unknown[] = []) {
        if (sql.trim().startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
          return { rows: [{ org_id: "org_denied" }], rowCount: 1 };
        }
        return super.query(sql, params);
      }
    }
    const pool = new ProjectDeniedPool();
    const app = new Hono<ActorContextEnv>();
    app.use(
      "*",
      createAuthMiddleware({
        store: {
          async findApiTokenByRaw() {},
          async loadSession() {},
          async resolveActorContext() {
            return alice;
          },
        } as never,
        localDevActor: alice,
      }),
    );
    app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
    const { runId } = seedVisibleRun(pool);

    const response = await app.request(`/orgs/org_acme/runs/${runId}/location`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run_not_found" });
  });

  it("404s when the project org mismatches the path org, including platform:admin", async () => {
    // runs.org_id can disagree with projects.org_id (independent FKs). The
    // location route must bind assertProjectAccess.orgId to the path org.
    const { app, pool } = buildHarness(platformAdmin);
    pool.seedProject({ project_id: "project_foreign", org_id: "org_foreign" });
    pool.seedSpec({ spec_id: "spec_foreign", project_id: "project_foreign" });
    // Run claims path org but points at a project that lives elsewhere.
    pool.seedRun({
      run_id: "run_mismatched",
      spec_id: "spec_foreign",
      project_id: "project_foreign",
      org_id: "org_acme",
      status: "running",
    });

    const response = await app.request(`/orgs/org_acme/runs/run_mismatched/location`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run_not_found" });

    const summaries = runSummaryQueries(pool);
    expect(summaries.some((q) => q.params[0] === "run_mismatched" && q.params[1] === "org_acme")).toBe(true);
  });

  it("lets platform:admin resolve a run when project org matches the path org", async () => {
    const { app, pool } = buildHarness(platformAdmin);
    const { runId, projectId } = seedVisibleRun(pool, "run_admin_ok");
    const response = await app.request(`/orgs/org_acme/runs/${runId}/location`);
    expect(response.status).toBe(200);
    expect(RunLocation.parse(await response.json())).toEqual({ orgId: "org_acme", projectId });
  });
});
