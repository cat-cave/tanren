import { Pool } from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../src/auth/schemas.js";
import type { AuthoringAuthorer } from "../src/engine/contracts/authoringKernel.js";
import { compilePolicy } from "../src/engine/governance/policyCompiler.js";
import {
  GovernanceFragmentStore,
  policyFromLayers,
  type GovernanceFragmentDraft,
} from "../src/engine/governance/fragments/index.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createGovernanceRoutes } from "../src/routes/governance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appRole = "tanren_app";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const orgA = "org_gv10_a";
const orgB = "org_gv10_b";
const projectA = "project_gv10_a";
const adminActor: ActorContext = {
  userId: "user_gv10_admin",
  orgId: orgA,
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

function databaseName(): string {
  return `tanren_gv10_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, runtime = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (runtime) {
    parsed.username = appRole;
    parsed.password = appPassword;
  }
  return parsed.toString();
}

function draft(): GovernanceFragmentDraft {
  const policy = policyFromLayers({
    core: { rules: [] },
    org: { rules: [{ key: "repository.visibility", value: "private" }] },
    tier: { rules: [] },
    binding: { rules: [] },
  });
  const compiled = compilePolicy(policy);
  if (compiled.status !== "compiled") throw new Error("fixture policy must compile");
  return {
    spec: {
      fragmentId: "private-repository",
      version: "1.0.0",
      dependsOn: ["base"],
      derivation: {
        personaRevisionIds: ["persona-private"],
        behaviorRevisionIds: ["behavior-private"],
        designEntityIds: ["repository"],
        riskClassifications: ["confidentiality"],
      },
      requiredPolicy: {
        core: { rules: [] },
        org: { rules: [{ key: "repository.visibility", value: "private" }] },
        tier: { rules: [] },
        binding: { rules: [] },
      },
    },
    policy: {
      core: { rules: [] },
      org: { rules: [{ key: "repository.visibility", value: "private" }] },
      tier: { rules: [] },
      binding: { rules: [] },
    },
    conformance: { positive: [policy], negative: [{ apiVersion: "invalid" }] },
    simulatorSnapshots: [{ scenarioId: "private", policy, expectedPolicyHash: compiled.policyHash }],
    uiFormSchema: { type: "object" },
    compatibility: "tanren.dev/governance/v2",
  };
}

function fragmentConfig() {
  return {
    apiVersion: "tanren.dev/governance-fragments/v1" as const,
    schemaVersion: 1 as const,
    fragments: [draft().spec],
  };
}

function app(pool: Pool): Hono<ActorContextEnv> {
  const writer: AuthoringAuthorer<GovernanceFragmentDraft["spec"], GovernanceFragmentDraft> = {
    async author(input) {
      return { ...draft(), spec: input.spec, policy: input.spec.requiredPolicy };
    },
  };
  const result = new Hono<ActorContextEnv>();
  result.use("*", async (c, next) => {
    c.set("actor", adminActor);
    await next();
  });
  result.route("/orgs", createGovernanceRoutes({ pool, governanceFragmentAuthorer: () => writer }));
  return result;
}

describeDb("gv-10 governance fragment RLS", () => {
  const database = databaseName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: databaseUrl(adminUrl, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: databaseUrl(adminUrl, database, true) });
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb),
              ($2, 'oidc', $2, $2, $2, '{"version":1}'::jsonb)`,
      [orgA, orgB],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [projectA, orgA],
    );
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("runs as tanren_app without superuser or bypass-RLS authority", async () => {
    const identity = await runWithOrgScope(runtimePool, orgA, (client) =>
      client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
      ),
    );
    expect(identity.rows[0]).toEqual({ current_user: appRole, rolsuper: false, rolbypassrls: false });
  });

  it("drives the production HTTP composer, then proves org B plus unscoped reads see zero rows", async () => {
    const store = new GovernanceFragmentStore(runtimePool);
    const response = await app(runtimePool).request(`/orgs/${orgA}/projects/${projectA}/governance/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fragmentConfig: fragmentConfig() }),
    });
    expect(response.status).toBe(201);
    expect((await store.listValidated(orgA)).map((row) => row.draft.spec.fragmentId)).toEqual(["private-repository"]);
    expect(await store.listValidated(orgB)).toEqual([]);

    const crossOrg = await runWithOrgScope(runtimePool, orgB, (client) =>
      client.query("SELECT id FROM governance_fragments"),
    );
    expect(crossOrg.rowCount).toBe(0);
    expect((await runtimePool.query("SELECT id FROM governance_fragments")).rowCount).toBe(0);
    const events = await runWithOrgScope(runtimePool, orgA, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type FROM events
          WHERE org_id = $1 AND project_id = $2 AND event_type LIKE 'governanceFragment.authoring.%'
          ORDER BY id`,
        [orgA, projectA],
      ),
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "governanceFragment.authoring.started",
      "governanceFragment.authoring.attempt",
      "governanceFragment.authoring.succeeded",
    ]);
  });
});
