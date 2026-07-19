// gv-14 — route tests for the governance import facade's FAIL-CLOSED gates that
// reject BEFORE any transaction opens: a malformed or contradictory bundle, an
// unauthorized caller. These paths never touch the governance tables, so they
// run against the in-memory RoutesPool; the atomic commit/rollback proof lives
// in governanceImport.rls.integration.test.ts against a real Postgres.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { GOVERNANCE_IMPORT_API_VERSION } from "../src/engine/governance/governanceImport.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
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

function policy(rules: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  return {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules },
    org: { rules: [] },
    tier: { rules: [] },
    binding: { rules: [] },
  };
}

const VALID_POLICY = policy([
  { key: "review.mode", value: "human" },
  { key: "review.minimum_approvals", value: 2 },
]);

// review.mode auto with a required principal — a deterministic contradiction.
const CONTRADICTORY_POLICY = {
  apiVersion: "tanren.dev/governance/v2",
  schemaVersion: 1,
  core: {
    rules: [
      { key: "review.mode", value: "auto" },
      { key: "review.minimum_approvals", value: 0 },
    ],
  },
  org: { rules: [] },
  tier: { rules: [] },
  binding: { rules: [{ key: "review.required_principal", value: { kind: "user", name: "auditor" } }] },
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
  app.route("/orgs", createGovernanceRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

async function importBundle(app: Hono<ActorContextEnv>, bundle: unknown, orgId = "org_acme") {
  const res = await app.request(`/orgs/${orgId}/projects/proj_1/governance/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
}

describe("gv-14 governance import facade — fail-closed gates", () => {
  it("a non-admin caller cannot import (403), no governance write", async () => {
    const { app, pool } = buildHarness(memberOnly);
    const { status, body } = await importBundle(app, {
      apiVersion: GOVERNANCE_IMPORT_API_VERSION,
      tiers: [{ tierName: "standard", preset: "standard" }],
    });
    expect(status).toBe(403);
    expect(body.error).toBe("governance_admin_required");
    expect(pool.events).toEqual([]);
  });

  it("a foreign-org path is denied (403)", async () => {
    const { app } = buildHarness();
    const { status } = await importBundle(
      app,
      { apiVersion: GOVERNANCE_IMPORT_API_VERSION, tiers: [{ tierName: "standard", preset: "standard" }] },
      "org_other",
    );
    expect(status).toBe(403);
  });

  it("an unknown bundle apiVersion is rejected 400 before any work", async () => {
    const { app, pool } = buildHarness();
    const { status, body } = await importBundle(app, { apiVersion: "wrong/v9", tiers: [] });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_governance_import");
    expect(pool.events).toEqual([]);
  });

  it("a malformed policy in the bundle rejects the WHOLE import 400 (index reported)", async () => {
    const { app, pool } = buildHarness();
    const { status, body } = await importBundle(app, {
      apiVersion: GOVERNANCE_IMPORT_API_VERSION,
      tiers: [{ tierName: "standard", preset: "standard" }],
      policies: [{ sourceDocument: VALID_POLICY }, { sourceDocument: policy([{ key: "bogus.key", value: 1 }]) }],
    });
    expect(status).toBe(400);
    expect(body.error).toBe("governance_import_malformed_policy");
    expect(body.index).toBe(1);
    // No tier or revision was created — the reject precedes the transaction.
    expect(pool.events).toEqual([]);
  });

  it("a contradictory policy rejects the WHOLE import 422 with witnesses, never a partial apply", async () => {
    const { app, pool } = buildHarness();
    const { status, body } = await importBundle(app, {
      apiVersion: GOVERNANCE_IMPORT_API_VERSION,
      tiers: [{ tierName: "standard", preset: "standard" }],
      policies: [{ sourceDocument: CONTRADICTORY_POLICY }],
    });
    expect(status).toBe(422);
    expect(body.error).toBe("governance_import_contradictory_policy");
    expect(body.index).toBe(0);
    expect(Array.isArray(body.contradictionWitnesses)).toBe(true);
    expect((body.contradictionWitnesses as unknown[]).length).toBeGreaterThan(0);
    expect(pool.events).toEqual([]);
  });

  it("an empty (unknown-field) bundle is rejected 400 by the strict schema", async () => {
    const { app } = buildHarness();
    const { status } = await importBundle(app, {
      apiVersion: GOVERNANCE_IMPORT_API_VERSION,
      surprise: true,
    });
    expect(status).toBe(400);
  });
});
