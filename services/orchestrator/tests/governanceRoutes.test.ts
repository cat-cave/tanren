// Route tests for the per-project GOVERNANCE surface (apex.md "missing endpoint →
// add it"): the supported way to flip an existing project to autonomous without a
// hand-crafted full-config PATCH. Drives the REAL project route handlers against
// the in-memory RoutesPool (mirrors budgetRoutes.test.ts):
//   - GET  /:orgId/projects/:projectId/governance → reviewPolicy/mergeIntegration/posture;
//   - PUT  sets the three settings (read-back reflects them; omitted keys untouched);
//   - a non-admin actor is rejected with 403 on the MUTATION (org-admin authorized);
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
  // `secrets`/`githubHttp` are only used by the greenfield create path, never by
  // the governance routes — stubbed for construction only.
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return { app, pool };
}

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

describe("project governance routes", () => {
  it("reads the schema defaults when no governance is configured", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
    expect(body.reviewPolicy).toBe("human");
    expect(body.mergeIntegration).toBe("not_configured");
    expect(body.governancePosture).toBe("strict");
  });

  it("flips a project to autonomous and the read-back reflects it (round-trip)", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      reviewPolicy: "auto",
      mergeIntegration: "native_queue",
    });
    expect(put.status).toBe(200);
    expect(put.body.reviewPolicy).toBe("auto");
    expect(put.body.mergeIntegration).toBe("native_queue");
    // Unset field keeps its current (default) value.
    expect(put.body.governancePosture).toBe("strict");

    const get = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(get.body.reviewPolicy).toBe("auto");
    expect(get.body.mergeIntegration).toBe("native_queue");
    expect(get.body.governancePosture).toBe("strict");
  });

  it("updates only the named field, leaving the others untouched", async () => {
    const { app } = buildHarness();
    await putJson(app, "/orgs/org_acme/projects/proj_1/governance", {
      reviewPolicy: "simulated",
      mergeIntegration: "native_queue",
    });
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { governancePosture: "open" });
    expect(put.status).toBe(200);
    expect(put.body.reviewPolicy).toBe("simulated");
    expect(put.body.mergeIntegration).toBe("native_queue");
    expect(put.body.governancePosture).toBe("open");
  });

  it("rejects an unknown reviewPolicy value with 400", async () => {
    const { app } = buildHarness();
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { reviewPolicy: "nope" });
    expect(put.status).toBe(400);
  });

  it("404s an unknown project", async () => {
    const { app } = buildHarness();
    const { status } = await getJson(app, "/orgs/org_acme/projects/nope/governance");
    expect(status).toBe(404);
  });

  it("rejects a governance mutation from a non-admin actor with 403", async () => {
    const { app } = buildHarness(memberOnly);
    const put = await putJson(app, "/orgs/org_acme/projects/proj_1/governance", { reviewPolicy: "auto" });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe("org_admin_required");
  });

  it("allows a non-admin member to READ governance", async () => {
    const { app } = buildHarness(memberOnly);
    const { status } = await getJson(app, "/orgs/org_acme/projects/proj_1/governance");
    expect(status).toBe(200);
  });
});
