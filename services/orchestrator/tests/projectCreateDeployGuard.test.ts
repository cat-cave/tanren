import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore, type CommandSubstrate } from "../src/engine/contracts/index.js";
import type { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { createProject } from "../src/engine/workflow/projectSpec.js";
import { mountRootApiRoutes } from "../src/mountRootApiRoutes.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { inertGitHubHttp } from "./helpers/githubHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

describe("generic project creation deploy guard", () => {
  it("rejects org-scoped greenfield config before creating a project", async () => {
    const { app, pool } = orgProjectHarness();
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Apex",
        repoUrl: "https://github.com/acme/apex",
        config: { version: 1, greenfield: true },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_greenfield_project_config",
      fields: ["greenfield"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects org-scoped caller-supplied deploy target config before creating a project", async () => {
    const { app, pool } = orgProjectHarness();
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fake deploy",
        repoUrl: "https://github.com/acme/fake-deploy",
        config: { version: 1, deployProvider: "deploy.vercel", deployAppId: "app_manual" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_deploy_project_config",
      fields: ["deployProvider", "deployAppId"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it.each([
    [
      "governance posture",
      { version: 1, governancePosture: "open" },
      "manual_autonomous_project_config",
      ["governancePosture"],
    ],
    [
      "direct merge integration",
      { version: 1, mergeIntegration: "direct_merge" },
      "manual_autonomous_project_config",
      ["mergeIntegration"],
    ],
    [
      "preview URL pattern",
      { version: 1, previewUrlPattern: "https://fake-deploy.example.test" },
      "manual_deploy_project_config",
      ["previewUrlPattern"],
    ],
  ])(
    "rejects org-scoped caller-supplied reserved %s before creating a project",
    async (label, config, error, fields) => {
      const { app, pool } = orgProjectHarness();
      const response = await app.request("/orgs/org_acme/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Reserved ${label}`,
          repoUrl: `https://github.com/acme/reserved-${String(label).replaceAll(" ", "-")}`,
          config,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error, fields });
      expect(pool.projects.size).toBe(0);
    },
  );

  it("still allows org-scoped brownfield config", async () => {
    const { app, pool } = orgProjectHarness();
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Brownfield",
        repoUrl: "https://github.com/acme/brownfield",
        config: { version: 1, greenfield: false, reviewPolicy: "human" },
      }),
    });

    expect(response.status).toBe(201);
    expect(pool.projects.size).toBe(1);
  });

  it("rejects org-scoped caller-supplied autonomous native-queue config before creating a project", async () => {
    const { app, pool } = orgProjectHarness();
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Manual autonomous",
        repoUrl: "https://github.com/acme/manual-autonomous",
        config: { version: 1, reviewPolicy: "auto", mergeIntegration: "native_queue" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_autonomous_project_config",
      fields: ["reviewPolicy", "mergeIntegration"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects root greenfield config before creating a project", async () => {
    const { app, pool } = rootProjectHarness();
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Root apex",
        repoUrl: "https://github.com/acme/root-apex",
        config: { version: 1, greenfield: true },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "manual_greenfield_project_config" });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects root caller-supplied deploy target config before creating a project", async () => {
    const { app, pool } = rootProjectHarness();
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Root fake deploy",
        repoUrl: "https://github.com/acme/root-fake-deploy",
        config: { version: 1, deployProvider: "deploy.flyio", deployAppId: "app_manual" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_deploy_project_config",
      fields: ["deployProvider", "deployAppId"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects root caller-supplied autonomous native-queue config before creating a project", async () => {
    const { app, pool } = rootProjectHarness();
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Root manual autonomous",
        repoUrl: "https://github.com/acme/root-manual-autonomous",
        config: { version: 1, reviewPolicy: "simulated", mergeIntegration: "native_queue" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_autonomous_project_config",
      fields: ["reviewPolicy", "mergeIntegration"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it.each([
    [
      "governance posture",
      { version: 1, governancePosture: "audit_only" },
      "manual_autonomous_project_config",
      ["governancePosture"],
    ],
    [
      "direct merge integration",
      { version: 1, mergeIntegration: "direct_merge" },
      "manual_autonomous_project_config",
      ["mergeIntegration"],
    ],
    [
      "preview URL pattern",
      { version: 1, previewUrlPattern: "https://root-fake-deploy.example.test" },
      "manual_deploy_project_config",
      ["previewUrlPattern"],
    ],
  ])("rejects root caller-supplied reserved %s before creating a project", async (label, config, error, fields) => {
    const { app, pool } = rootProjectHarness();
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Root reserved ${label}`,
        repoUrl: `https://github.com/acme/root-reserved-${String(label).replaceAll(" ", "-")}`,
        config,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error, fields });
    expect(pool.projects.size).toBe(0);
  });

  it.each([
    ["greenfield marker", { version: 1, greenfield: true }, ["greenfield"]],
    [
      "fake deploy target",
      { version: 1, deployProvider: "deploy.vercel", deployAppId: "app_manual" },
      ["deployProvider", "deployAppId"],
    ],
    [
      "fake deploy preview URL",
      { version: 1, previewUrlPattern: "https://manual-preview.example.test" },
      ["previewUrlPattern"],
    ],
    [
      "autonomy fields",
      { version: 1, reviewPolicy: "auto", mergeIntegration: "native_queue" },
      ["reviewPolicy", "mergeIntegration"],
    ],
  ])("rejects full config PATCH with %s", async (_label, config, fields) => {
    const { app, pool } = orgProjectHarness();
    pool.seedProject({ project_id: "project_existing", org_id: "org_acme", config: { version: 1 } });

    const response = await app.request("/orgs/org_acme/projects/project_existing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, revision: "1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "reserved_project_config_patch", fields });
    expect(pool.projects.get("project_existing")?.config).toEqual({ version: 1 });
  });

  it("allows full config PATCH when reserved defaults are unchanged", async () => {
    const { app, pool } = orgProjectHarness();
    pool.seedProject({ project_id: "project_existing", org_id: "org_acme", config: { version: 1 } });

    const response = await app.request("/orgs/org_acme/projects/project_existing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          greenfield: false,
          reviewPolicy: "human",
          mergeIntegration: "not_configured",
          governancePosture: "strict",
          credentials: { githubCredentialRef: "credential/github/project" },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      config: { credentials: { githubCredentialRef: "credential/github/project" } },
    });
  });

  // gv-1: member PATCH must not mutate governance-owned auditPosture (nested object).
  it("rejects full config PATCH that changes auditPosture (authorization bypass)", async () => {
    const { app, pool } = orgProjectHarness(memberActor);
    pool.seedProject({ project_id: "project_existing", org_id: "org_acme", config: { version: 1 } });

    const response = await app.request("/orgs/org_acme/projects/project_existing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditPosture: { blockReviewAt: "P3", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "reserved_project_config_patch",
      fields: ["auditPosture"],
    });
    expect(pool.projects.get("project_existing")?.config).toEqual({ version: 1 });
    expect(pool.events).toEqual([]);
  });

  // Structural equality: re-stated default posture is not a reserved change.
  it("allows full config PATCH when auditPosture is re-stated unchanged", async () => {
    const { app, pool } = orgProjectHarness(memberActor);
    pool.seedProject({ project_id: "project_existing", org_id: "org_acme", config: { version: 1 } });

    const response = await app.request("/orgs/org_acme/projects/project_existing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditPosture: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
          credentials: { githubCredentialRef: "credential/github/project" },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(200);
    expect(pool.projects.get("project_existing")?.config).toMatchObject({
      auditPosture: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
    });
    expect(pool.events).toEqual([]);
  });

  it("rejects org-scoped create that supplies auditPosture before insert", async () => {
    const { app, pool } = orgProjectHarness();
    const response = await app.request("/orgs/org_acme/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Posture create",
        repoUrl: "https://github.com/acme/posture-create",
        config: {
          version: 1,
          auditPosture: { blockReviewAt: "P3", p2p3Handling: "route-to-dag", autonomousRemediation: true },
        },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_autonomous_project_config",
      fields: ["auditPosture"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it.each([
    [
      "fake deploy target",
      { version: 1, deployProvider: "deploy.vercel", deployAppId: "app_manual" },
      "manual_deploy_project_config",
      ["deployProvider", "deployAppId"],
    ],
    [
      "fake deploy preview URL",
      { version: 1, previewUrlPattern: "https://internal-preview.example.test" },
      "manual_deploy_project_config",
      ["previewUrlPattern"],
    ],
    [
      "governance posture",
      { version: 1, governancePosture: "lenient" },
      "manual_autonomous_project_config",
      ["governancePosture"],
    ],
    [
      "direct merge integration",
      { version: 1, mergeIntegration: "direct_merge" },
      "manual_autonomous_project_config",
      ["mergeIntegration"],
    ],
  ])(
    "rejects reserved %s at the internal createProject boundary before insert",
    async (_label, config, error, fields) => {
      const pool = new RoutesPool();

      await expect(
        createProject(
          pool.asPgPool(),
          {
            name: "Internal reserved config",
            repoUrl: "https://github.com/acme/internal-reserved-config",
            config,
          },
          actor,
        ),
      ).rejects.toMatchObject({ response: { error, fields } });
      expect(pool.projects.size).toBe(0);
    },
  );
});

const memberActor: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function orgProjectHarness(boundActor: ActorContext = actor) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", boundActor.userId, boundActor.scopes.includes("org:admin") ? "admin" : "member");
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
  app.route(
    "/orgs",
    createProjectRoutes({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      githubHttp: {} as never,
    }),
  );
  return { app, pool };
}

function rootProjectHarness() {
  const pool = new RoutesPool();
  const app = new Hono<ActorContextEnv>();
  mountRootApiRoutes(app, {
    pool: pool.asPgPool(),
    secrets: new InMemorySecretStore(),
    githubHttp: inertGitHubHttp(),
    githubAppMinter: {} as GithubAppTokenMinter,
    identitySecretRef: "secret/identity",
    ssh: {} as CommandSubstrate,
  });
  return { app, pool };
}
