import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { emptyCapture, type InterviewAnswerer } from "../src/engine/forge/interview/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOnboardingRoutes, type OnboardingRoutesOptions } from "../src/routes/onboarding/index.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";
import { RoutesPool } from "./helpers/routesPool.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const answerer: InterviewAnswerer = {
  async ask() {
    return { say: "done", captureDelta: {}, suggestions: [], complete: true };
  },
};

function appWithRoutes(
  pool: RoutesPool,
  vcsProvider = new InMemoryVcsProvider(),
  onboardingOverrides: Partial<Pick<OnboardingRoutesOptions, "preflightDeploy" | "prepareDeploy">> = {},
) {
  const app = new Hono<ActorContextEnv>();
  const secrets = new InMemorySecretStore();
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
  app.route(
    "/orgs",
    createOnboardingRoutes({
      pool: pool.asPgPool(),
      secrets,
      answererFactory: () => answerer,
      ...onboardingOverrides,
    }),
  );
  app.route(
    "/orgs",
    createProjectRoutes({
      pool: pool.asPgPool(),
      secrets,
      vcsProvider,
    }),
  );
  return { app, vcsProvider };
}

class LinkedDeployRoutesPool extends RoutesPool {
  override async query(sql: string, params: unknown[] = []) {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith(
        "SELECT id, org_id, provider_kind, credential_ref, metadata, capabilities, status FROM org_integrations",
      )
    ) {
      const [orgId, providerKind] = params as string[];
      return {
        rows: [
          {
            id: "integration_1",
            org_id: orgId,
            provider_kind: providerKind,
            credential_ref: "secret://missing/deploy-token",
            metadata: {},
            capabilities: ["deploy"],
            status: "linked",
          },
        ],
        rowCount: 1,
      };
    }
    return super.query(sql, params);
  }
}

describe("greenfield/apex deploy dependency routes", () => {
  it("rejects autonomous onboarding derive without a deploy provider before creating a project", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: emptyCapture(), autonomy: "auto" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; supportedProviderKinds: string[] };
    expect(body.error).toBe("deploy_provider_missing");
    expect(body.supportedProviderKinds).toEqual(["deploy.vercel", "deploy.flyio"]);
    expect(pool.projects.size).toBe(0);
  });

  it("rejects onboarding derive without deploy even when autonomy is omitted", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: emptyCapture() }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provider_missing");
    expect(pool.projects.size).toBe(0);
  });

  it("rejects autonomous onboarding derive when the named deploy provider is not linked", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: emptyCapture(),
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string; providerKind: string; linkAffordance: unknown };
    expect(body.error).toBe("deploy_not_linked");
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("deploy.vercel");
    expect(body.linkAffordance).toEqual({
      kind: "org_integration_link",
      providerKind: "deploy.vercel",
      orgId: "org_acme",
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects onboarding derive when deploy preparation fails after linked preflight", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool, new InMemoryVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        throw new Error("deploy provision failed: provider token expired");
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: emptyCapture(),
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("deploy_provision_failed");
    expect(body.message).toContain("provider token expired");
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
  });

  it("rejects direct greenfield project creation without deploy config before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "apex-url-shortener", owner: "cat-cave", greenfield: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provider_missing");
    expect(pool.projects.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation when deploy provider is not linked before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "apex-url-shortener",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string; providerKind: string };
    expect(body.error).toBe("deploy_not_linked");
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("deploy.vercel");
    expect(pool.projects.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation when linked deploy provider fails before creating a repo", async () => {
    const pool = new LinkedDeployRoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "apex-url-shortener",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provision_failed");
    expect(pool.projects.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });
});
