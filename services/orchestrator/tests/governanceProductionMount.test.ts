// GV-15: exercise the actual production feature mount. This prevents the
// governance factory from becoming another constructed-but-dead HTTP seam.

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { mountFeatureRoutes } from "../src/mountFeatureRoutes.js";

function pool(): pg.Pool {
  return { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
}

describe("governance production route mount", () => {
  it("registers gv-7..14 reads and commands through mountFeatureRoutes", () => {
    const secrets = new InMemorySecretStore();
    const app = new Hono<ActorContextEnv>();
    mountFeatureRoutes(app, {
      pool: pool(),
      secrets,
      githubHttp: {} as never,
      githubAppMinter: new GithubAppTokenMinter({ secrets }),
      credentialRegistry: {} as never,
      configGateGithub: async () => {
        throw new Error("not called while mounting");
      },
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
      allocator: {} as never,
      ssh: new FakeCommandSubstrate(),
      identitySecretRef: "secret/runner",
    });
    const registered = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(registered).toContain("GET /orgs/:orgId/projects/:projectId/governance/revisions");
    expect(registered).toContain("GET /orgs/:orgId/projects/:projectId/governance/bindings");
    expect(registered).toContain("GET /orgs/:orgId/projects/:projectId/governance/tiers");
    expect(registered).toContain("POST /orgs/:orgId/projects/:projectId/governance/revisions");
    expect(registered).toContain("POST /orgs/:orgId/projects/:projectId/governance/revisions/:revision/activate");
    expect(registered).toContain("POST /orgs/:orgId/projects/:projectId/governance/tiers/:tierId/bind");
  });
});
