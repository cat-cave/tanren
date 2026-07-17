import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { RepositoryVisibilityDecision } from "../src/engine/governance/repoVisibility.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import type { RepositoryVisibilityService } from "../src/routes/projects/repositoryVisibility.js";

const actor: ActorContext = {
  userId: "repository-visibility-admin",
  orgId: "org_route_visibility",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function decision(status: RepositoryVisibilityDecision["status"]): RepositoryVisibilityDecision {
  const observation = {
    orgId: "org_route_visibility",
    projectId: "project_route_visibility",
    observationId: `repo_visibility_${status}`,
    observedVisibility: status === "allowed" ? ("private" as const) : ("public" as const),
    forgeRef: "github:example/private-repo",
    sha: `${status}-sha`,
    observedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  return status === "allowed"
    ? { status, expectedVisibility: "private", observation }
    : { status, expectedVisibility: "private", observation };
}

function buildApp(service: RepositoryVisibilityService): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  app.route(
    "/orgs",
    createProjectRoutes({
      pool: {} as never,
      secrets: {} as never,
      githubHttp: {} as never,
      repositoryVisibilityService: service,
    }),
  );
  return app;
}

describe("repository visibility project HTTP surface", () => {
  it("returns the immutable readback and maps allowed and blocked enforcement decisions", async () => {
    const service: RepositoryVisibilityService = {
      read: async () => ({ declaredVisibility: "private", observations: [decision("allowed").observation] }),
      observe: async () => decision("allowed"),
    };
    const app = buildApp(service);

    const read = await app.request(
      "/orgs/org_route_visibility/projects/project_route_visibility/repository-visibility",
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      declaredVisibility: "private",
      observations: [{ observationId: expect.any(String) }],
    });

    const allowed = await app.request(
      "/orgs/org_route_visibility/projects/project_route_visibility/repository-visibility/observe",
      { method: "POST" },
    );
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toMatchObject({ status: "allowed", expectedVisibility: "private" });

    const blockedApp = buildApp({ ...service, observe: async () => decision("blocked") });
    const blocked = await blockedApp.request(
      "/orgs/org_route_visibility/projects/project_route_visibility/repository-visibility/observe",
      { method: "POST" },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ status: "blocked", expectedVisibility: "private" });
  });
});
