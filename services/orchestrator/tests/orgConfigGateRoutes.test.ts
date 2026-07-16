// audit-gate org-config PATCH route tests. Builds the org route with an
// injected (mocked) GitHub port and asserts the gate behavior end-to-end at the
// route layer:
//   - gate ON + Bucket-B write  → 202 + PR opened, DB NOT mutated;
//   - gate ON + toggle-only      → applies directly (no PR);
//   - gate OFF                   → applies the Bucket-B write directly.

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { migrateOrgConfig } from "../src/engine/config/orgConfig.js";
import type { ConfigGateGitHub } from "../src/engine/config/tanrenConfigGate.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createOrgRoutes, type ConfigGateGithubFactory } from "../src/routes/orgs/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function buildHarness(github: ConfigGateGitHub) {
  const pool = new RoutesPool();
  const openConfigPr = vi.spyOn(github, "openConfigPr");
  const configGateGithub: ConfigGateGithubFactory = async () => github;
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return admin;
        },
      } as never,
      localDevActor: admin,
    }),
  );
  app.route("/orgs", createOrgRoutes({ pool: pool.asPgPool(), configGateGithub }));
  return { app, pool, openConfigPr };
}

function fakeGithub(): ConfigGateGitHub {
  return {
    async openConfigPr() {
      return {
        number: 7,
        url: "https://github.com/cat-cave/tanren-config/pull/7",
        branch: "forge/route-x",
      };
    },
  };
}

// A gate-ON config that changes the audit routing chain (a Bucket-B write).
function gatedBucketBPatch(): unknown {
  return {
    version: 1,
    auditGateEnabled: true,
    auditGate: { repo: "cat-cave/tanren-config" },
    routing: {
      audit: { chain: [{ cli: "claude", model: "opus-4.7", authRef: "credential/claude" }] },
    },
  };
}

function seedGateOn(pool: RoutesPool): void {
  pool.seedOrg({
    id: "org_acme",
    login: "acme",
    config: { version: 1, auditGateEnabled: true, auditGate: { repo: "cat-cave/tanren-config" } },
  });
}

describe("audit-gate org-config PATCH route", () => {
  it("rejects a cross-org GitHub ref before persistence or audit-gate provider I/O", async () => {
    const github = fakeGithub();
    const { app, pool, openConfigPr } = buildHarness(github);
    seedGateOn(pool);

    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditGateEnabled: true,
          auditGate: { repo: "cat-cave/tanren-config" },
          defaultCredentials: { github_token: "credential/github/org/org_other/default" },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(400);
    expect(openConfigPr).not.toHaveBeenCalled();
    expect(migrateOrgConfig(pool.orgs.get("org_acme")?.config).defaultCredentials).toBeUndefined();
  });

  it("derives a bare GitHub credential name into the addressed org namespace", async () => {
    const github = fakeGithub();
    const { app, pool, openConfigPr } = buildHarness(github);
    pool.seedOrg({ id: "org_acme", login: "acme", config: { version: 1 } });

    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { version: 1, defaultCredentials: { github_token: "default" } },
        revision: "1",
      }),
    });

    expect(response.status).toBe(200);
    expect(openConfigPr).not.toHaveBeenCalled();
    expect(migrateOrgConfig(pool.orgs.get("org_acme")?.config).defaultCredentials?.github_token).toBe(
      "credential/github/org/org_acme/default",
    );
  });

  it("gate ON + Bucket-B write → 202, opens a PR, does NOT mutate the DB", async () => {
    const github = fakeGithub();
    const { app, pool, openConfigPr } = buildHarness(github);
    seedGateOn(pool);

    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: gatedBucketBPatch(), revision: "1" }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { gated: boolean; pr: { number: number } };
    expect(body.gated).toBe(true);
    expect(body.pr.number).toBe(7);
    expect(openConfigPr).toHaveBeenCalledOnce();
    // DB untouched: the stored config still has no audit routing chain.
    const stored = migrateOrgConfig(pool.orgs.get("org_acme")?.config);
    expect(stored.routing.audit.chain).toEqual([]);
  });

  it("gate ON + toggle-only change → applies directly, no PR", async () => {
    const github = fakeGithub();
    const { app, pool, openConfigPr } = buildHarness(github);
    pool.seedOrg({
      id: "org_acme",
      login: "acme",
      config: { version: 1, auditGateEnabled: false },
    });

    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          auditGateEnabled: true,
          auditGate: { repo: "cat-cave/tanren-config" },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(200);
    expect(openConfigPr).not.toHaveBeenCalled();
    const stored = migrateOrgConfig(pool.orgs.get("org_acme")?.config);
    expect(stored.auditGateEnabled).toBe(true);
  });

  it("gate OFF → applies a Bucket-B write directly", async () => {
    const github = fakeGithub();
    const { app, pool, openConfigPr } = buildHarness(github);
    pool.seedOrg({
      id: "org_acme",
      login: "acme",
      config: { version: 1, auditGateEnabled: false },
    });

    const response = await app.request("/orgs/org_acme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          version: 1,
          routing: {
            audit: { chain: [{ cli: "claude", model: "opus-4.7", authRef: "credential/claude" }] },
          },
        },
        revision: "1",
      }),
    });

    expect(response.status).toBe(200);
    expect(openConfigPr).not.toHaveBeenCalled();
    const stored = migrateOrgConfig(pool.orgs.get("org_acme")?.config);
    expect(stored.routing.audit.chain[0]?.model).toBe("opus-4.7");
  });
});
