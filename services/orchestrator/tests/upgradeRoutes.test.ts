// Route tests for the dependency-UPGRADE surface (environment-management.md §4.5/§7 P1).
//
// Drives the REAL `POST /orgs/:orgId/projects/:projectId/upgrade` project-route handler
// against the in-memory RoutesPool. The endpoint generates a version-change DAG NODE via
// the EXISTING spec-creation path — so the assertion that matters is that a successful
// call LANDS A SPEC (the gated DAG node), and a refusal lands NONE (no un-gated mutation).

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ProjectConfigV1 } from "../src/engine/config/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

// An org member of org_acme (NOT a platform admin) so the cross-org access check is
// meaningful. `createSpec`'s `ensureProjectAccess` grants on (matching org + org:member),
// so the in-org upgrade still creates the spec.
const member: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const baseLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

function buildHarness(projectConfigOverrides: Record<string, unknown>) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", "user_alice", "admin");
  pool.seedProject({
    project_id: "proj_1",
    org_id: "org_acme",
    config: ProjectConfigV1.parse({ version: 1, ...projectConfigOverrides }),
  });

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
  // `secrets`/`githubHttp` are only used by the greenfield create path, never by the
  // upgrade route — stubbed for construction only (mirrors budgetRoutes.test.ts).
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return { app, pool };
}

async function post(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method: "POST" });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("POST /orgs/:orgId/projects/:projectId/upgrade", () => {
  it("generates a gated upgrade DAG node (201) and a real spec is inserted", async () => {
    const { app, pool } = buildHarness({ lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" } });
    const { status, body } = await post(app, "/orgs/org_acme/projects/proj_1/upgrade");
    expect(status).toBe(201);
    expect(body.generated).toBe(true);
    expect(typeof body.specId).toBe("string");
    // The DAG node landed via the existing spec-creation path — the spec exists.
    expect(pool.specs.has(body.specId)).toBe(true);
    expect(pool.specs.get(body.specId)?.title).toContain("Upgrade dependencies to latest");
  });

  it("refuses (200, no spec) when the project is pinned (keepCurrent: false)", async () => {
    const { app, pool } = buildHarness({
      lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" },
      upgradePolicy: { keepCurrent: false, minimumReleaseAgeDays: 3 },
    });
    const { status, body } = await post(app, "/orgs/org_acme/projects/proj_1/upgrade");
    expect(status).toBe(200);
    expect(body).toEqual({ generated: false, reason: "policy_pinned" });
    expect(pool.specs.size).toBe(0);
  });

  it("refuses (200, no spec) when the project declares no `upgrade` command", async () => {
    const { app, pool } = buildHarness({ lifecycle: baseLifecycle });
    const { status, body } = await post(app, "/orgs/org_acme/projects/proj_1/upgrade");
    expect(status).toBe(200);
    expect(body).toEqual({ generated: false, reason: "no_upgrade_command" });
    expect(pool.specs.size).toBe(0);
  });

  it("denies a cross-org caller (403)", async () => {
    const { app, pool } = buildHarness({ lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" } });
    const { status } = await post(app, "/orgs/org_other/projects/proj_1/upgrade");
    expect(status).toBe(403);
    expect(pool.specs.size).toBe(0);
  });
});
