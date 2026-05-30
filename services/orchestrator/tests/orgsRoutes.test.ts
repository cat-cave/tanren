import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOrgRoutes } from "../src/routes/orgs/index.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";
import { RoutesPool } from "./helpers/routesPool.js";

function buildHarness(actor: ActorContext) {
  const pool = new RoutesPool();
  const identityPool = createFakeIdentityPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createOrgRoutes({ pool: pool.asPgPool() }));
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool() }));
  return { app, pool, identityPool };
}

const aliceInAcme: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

describe("org routes", () => {
  it("lists orgs the actor is a member of", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_acme", login: "acme", display_name: "Acme" });
    pool.seedOrg({ id: "org_other", login: "other", display_name: "Other" });
    pool.seedMembership("org_acme", "user_alice", "admin");

    const response = await app.request("/orgs");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { orgs: Array<{ id: string }> };
    expect(body.orgs.map((o) => o.id)).toEqual(["org_acme"]);
  });

  it("returns 403 reading an org the actor is not a member of", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_other" });
    const response = await app.request("/orgs/org_other");
    expect(response.status).toBe(403);
  });

  it("reads the addressed org with config defaults applied", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_acme", login: "acme", display_name: "Acme" });
    const response = await app.request("/orgs/org_acme");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; config: { version: number } };
    expect(body.id).toBe("org_acme");
    expect(body.config.version).toBe(1);
  });

  it("patches the org config when the actor is an org admin", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_acme", login: "acme", display_name: "Acme" });
    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { version: 1, auditGateEnabled: true } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; config: { auditGateEnabled: boolean } };
    expect(body.config.auditGateEnabled).toBe(true);
  });

  it("rejects org config patch from a non-admin actor", async () => {
    const memberOnly: ActorContext = {
      userId: "user_member",
      orgId: "org_acme",
      projectId: null,
      scopes: ["org:member"],
      source: "session",
    };
    const { app, pool } = buildHarness(memberOnly);
    pool.seedOrg({ id: "org_acme" });
    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { version: 1 } }),
    });
    expect(response.status).toBe(403);
  });

  it("lists projects scoped by org", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_acme" });
    pool.seedProject({ project_id: "project_a", org_id: "org_acme", name: "Alpha" });
    pool.seedProject({ project_id: "project_b", org_id: "org_other", name: "Beta" });
    const response = await app.request("/orgs/org_acme/projects");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ projectId: string }> };
    expect(body.projects.map((p) => p.projectId)).toEqual(["project_a"]);
  });

  it("rejects cross-org project read with 403/404 boundary semantics", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedProject({ project_id: "project_b", org_id: "org_other" });
    const response = await app.request("/orgs/org_other/projects/project_b");
    expect(response.status).toBe(403);
  });

  it("creates a project under the actor's org", async () => {
    const { app, pool } = buildHarness(aliceInAcme);
    pool.seedOrg({ id: "org_acme" });
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tanren", repoUrl: "https://github.com/cat-cave/x" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { projectId: string };
    expect(body.projectId).toMatch(/^project_/u);
  });
});
