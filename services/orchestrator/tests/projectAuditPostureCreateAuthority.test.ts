import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore, type CommandSubstrate } from "../src/engine/contracts/index.js";
import type { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { provisionedGreenfieldProjectConfigProof } from "../src/engine/workflow/projectConfigWriteGuards.js";
import { createProject } from "../src/engine/workflow/projectSpec.js";
import { mountRootApiRoutes } from "../src/mountRootApiRoutes.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { inertGitHubHttp } from "./helpers/githubHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";

const member: ActorContext = {
  userId: "user_member",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const defaultPosture = {
  blockReviewAt: "P1",
  p2p3Handling: "fix-if-idle",
  autonomousRemediation: false,
} as const;

const strictPosture = {
  blockReviewAt: "P3",
  p2p3Handling: "route-to-dag",
  autonomousRemediation: true,
} as const;

function orgHarness(): { app: Hono<ActorContextEnv>; pool: RoutesPool; path: string } {
  const pool = new RoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return member;
        },
      } as never,
      localDevActor: member,
    }),
  );
  app.route(
    "/orgs",
    createProjectRoutes({ pool: pool.asPgPool(), secrets: new InMemorySecretStore(), githubHttp: {} as never }),
  );
  return { app, pool, path: "/orgs/org_acme/projects" };
}

function rootHarness(): { app: Hono<ActorContextEnv>; pool: RoutesPool; path: string } {
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
  return { app, pool, path: "/projects" };
}

describe("audit-posture project-create authority", () => {
  it.each([
    ["org member", orgHarness, defaultPosture],
    ["root", rootHarness, strictPosture],
  ])("rejects caller-supplied auditPosture on the generic %s HTTP create", async (_label, harness, posture) => {
    const { app, pool, path } = harness();
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Reserved audit posture",
        repoUrl: "https://github.com/acme/reserved-audit-posture",
        config: { version: 1, auditPosture: posture },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "manual_autonomous_project_config",
      fields: ["auditPosture"],
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects caller-supplied auditPosture at the internal createProject boundary", async () => {
    const pool = new RoutesPool();
    await expect(
      createProject(
        pool.asPgPool(),
        {
          name: "Internal reserved posture",
          repoUrl: "https://github.com/acme/internal-reserved-posture",
          config: { version: 1, auditPosture: strictPosture },
        },
        member,
      ),
    ).rejects.toMatchObject({
      response: { error: "manual_autonomous_project_config", fields: ["auditPosture"] },
    });
    expect(pool.projects.size).toBe(0);
  });

  it("preserves the branded trusted-provisioning path for auditPosture", async () => {
    const pool = new RoutesPool();
    const project = await createProject(
      pool.asPgPool(),
      {
        name: "Trusted provisioned posture",
        repoUrl: "https://github.com/acme/trusted-provisioned-posture",
        config: { version: 1, auditPosture: strictPosture },
      },
      member,
      { configWriteProof: provisionedGreenfieldProjectConfigProof },
    );

    expect(project.config.auditPosture).toEqual(strictPosture);
    expect(pool.projects.get(project.projectId)?.config).toMatchObject({ auditPosture: strictPosture });
  });
});
