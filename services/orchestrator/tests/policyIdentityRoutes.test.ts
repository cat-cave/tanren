// gv-3 HTTP surface: GET /:orgId/projects/:projectId/policy-identity
// Named proof: `gv3_policy_identity_receipt` — org-scoped, runtime-validated.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createProjectRoutes } from "../src/routes/projects/index.js";
import { resolveProjectPolicyIdentity } from "../src/engine/governance/policyGateIdentity.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const outsider: ActorContext = {
  userId: "user_bob",
  orgId: "org_other",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function buildHarness(actor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", "user_alice", "admin");
  pool.seedOrg({ id: "org_other" });
  pool.seedMembership("org_other", "user_bob", "member");
  pool.seedProject({
    project_id: "proj_1",
    org_id: "org_acme",
    config: {
      version: 1,
      auditPosture: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
    },
  });

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
  app.route("/orgs", createProjectRoutes({ pool: pool.asPgPool(), secrets: {} as never, githubHttp: {} as never }));
  return { app, pool };
}

async function getJson(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("policy-identity routes (gv-3)", () => {
  it("returns the content hash receipt for an org member", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/policy-identity");
    expect(status).toBe(200);
    expect(body.proof).toBe("gv3_policy_identity_receipt");
    expect(body.schemaVersion).toBe(1);
    expect(body.policyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.policyHash).not.toBe("1");
    expect(body.fields).toContain("auditPosture");
    const expected = resolveProjectPolicyIdentity({
      version: 1,
      auditPosture: { blockReviewAt: "P1", p2p3Handling: "fix-if-idle", autonomousRemediation: false },
    }).policyHash;
    expect(body.policyHash).toBe(expected);
  });

  it("denies cross-org access (negative control)", async () => {
    const { app } = buildHarness(outsider);
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/proj_1/policy-identity");
    expect(status).toBe(403);
    expect(body.error).toBe("org_access_denied");
    expect(body.policyHash).toBeUndefined();
  });

  it("404s missing project without leaking hash", async () => {
    const { app } = buildHarness();
    const { status, body } = await getJson(app, "/orgs/org_acme/projects/missing/policy-identity");
    expect(status).toBe(404);
    expect(body.error).toBe("project_not_found");
    expect(body.policyHash).toBeUndefined();
  });
});
