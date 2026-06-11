// Route tests for the per-project LIFECYCLE surface (apex.md "missing endpoint →
// add it"): the supported way an operator PAUSES a project and resumes it. Drives
// the REAL project route handlers against the in-memory RoutesPool (mirrors
// governanceRoutes.test.ts):
//   - POST archive flips `lifecycle` to "archived" AND cancels the project's
//     in-flight (queued|running) runs, leaving terminal runs untouched;
//   - the project READ then reports `lifecycle: "archived"`;
//   - POST unarchive flips back to "active" (cancelling nothing);
//   - a non-admin actor is rejected 403 on either mutation (org-admin authorized);
//   - an unknown project 404s.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const memberOnly: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness(boundActor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", boundActor.userId, boundActor.scopes.includes("org:admin") ? "admin" : "member");
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return boundActor;
        },
      } as never,
      localDevActor: boundActor,
    }),
  );
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return { app, pool };
}

async function post(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method: "POST" });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("project lifecycle routes", () => {
  it("archives a project, cancels its in-flight runs, and the read reflects it", async () => {
    const { app, pool } = buildHarness();
    pool.seedRun({ run_id: "run_q", project_id: "proj_1", status: "queued" });
    pool.seedRun({ run_id: "run_r", project_id: "proj_1", status: "running" });
    pool.seedRun({ run_id: "run_done", project_id: "proj_1", status: "done" });

    const archived = await post(app, "/orgs/org_acme/projects/proj_1/archive");
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ projectId: "proj_1", lifecycle: "archived", cancelledRuns: 2 });

    // The two in-flight runs are cancelled; the terminal run is untouched.
    expect(pool.runs.find((r) => r["run_id"] === "run_q")?.["status"]).toBe("cancelled");
    expect(pool.runs.find((r) => r["run_id"] === "run_r")?.["status"]).toBe("cancelled");
    expect(pool.runs.find((r) => r["run_id"] === "run_done")?.["status"]).toBe("done");

    // The project read now reports the paused lifecycle.
    const read = await get(app, "/orgs/org_acme/projects/proj_1");
    expect(read.status).toBe(200);
    expect(read.body.lifecycle).toBe("archived");
  });

  it("unarchives a project back to active, cancelling nothing", async () => {
    const { app, pool } = buildHarness();
    await post(app, "/orgs/org_acme/projects/proj_1/archive");

    const unarchived = await post(app, "/orgs/org_acme/projects/proj_1/unarchive");
    expect(unarchived.status).toBe(200);
    expect(unarchived.body).toMatchObject({ projectId: "proj_1", lifecycle: "active", cancelledRuns: 0 });
    expect(pool.projects.get("proj_1")?.lifecycle).toBe("active");
  });

  it("a fresh project reads as active", async () => {
    const { app } = buildHarness();
    const read = await get(app, "/orgs/org_acme/projects/proj_1");
    expect(read.body.lifecycle).toBe("active");
  });

  it("rejects an archive from a non-admin actor with 403", async () => {
    const { app } = buildHarness(memberOnly);
    const res = await post(app, "/orgs/org_acme/projects/proj_1/archive");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("org_admin_required");
  });

  it("404s archiving an unknown project", async () => {
    const { app } = buildHarness();
    const res = await post(app, "/orgs/org_acme/projects/nope/archive");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("project_not_found");
  });
});
