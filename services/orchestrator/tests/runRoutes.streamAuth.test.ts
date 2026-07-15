import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const member: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const platformAdmin: ActorContext = {
  userId: "user_root",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function harness(actor?: ActorContext) {
  const pool = new RunRoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          if (actor === undefined) throw new Error("unexpected actor resolution");
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

function seed(pool: RunRoutesPool, runOrg = "org_acme", projectOrg = "org_acme"): void {
  pool.seedProject({ project_id: "project_x", org_id: projectOrg });
  pool.seedSpec({ spec_id: "spec_x", project_id: "project_x" });
  pool.seedRun({
    run_id: "run_x",
    spec_id: "spec_x",
    project_id: "project_x",
    org_id: runOrg,
    status: "running",
  });
}

describe("run SSE HTTP authorization and path binding", () => {
  it("rejects an unauthenticated stream before opening it", async () => {
    const { app, pool } = harness();
    seed(pool);
    const response = await app.request("/orgs/org_acme/projects/project_x/runs/run_x/stream");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", message: "authentication required" });
  });

  it("rejects a member addressing another organization before run lookup", async () => {
    const { app, pool } = harness({ ...member, orgId: "org_other" });
    seed(pool);
    const response = await app.request("/orgs/org_acme/projects/project_x/runs/run_x/stream");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "org_access_denied" });
    expect(pool.queries).toHaveLength(0);
  });

  it("hides a run when the URL project does not match its actual project", async () => {
    const { app, pool } = harness(member);
    seed(pool);
    const response = await app.request("/orgs/org_acme/projects/project_other/runs/run_x/stream");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run_not_found" });
  });

  it("binds platform-admin access to the run's exact organization", async () => {
    const { app, pool } = harness(platformAdmin);
    seed(pool);
    const response = await app.request("/orgs/org_other/projects/project_x/runs/run_x/stream");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run_not_found" });
  });

  it("fails closed when a run and its project carry inconsistent organizations", async () => {
    const { app, pool } = harness(platformAdmin);
    seed(pool, "org_other", "org_acme");
    const response = await app.request("/orgs/org_other/projects/project_x/runs/run_x/stream");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run_not_found" });
  });
});
