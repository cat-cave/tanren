// rv-6 A2 loader RLS proof. The PgAcceptancePlanLoader reads a behavior's stored
// acceptance spec from `behavior_revisions` under org scope as the restricted
// non-superuser tanren_app role, compiles it to the executable plan, and — because
// RLS denies cross-org rows — a load under another org's scope sees ZERO rows and
// fails loud (never a fabricated plan).
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { BehaviorRevisionNotFoundError, PgAcceptancePlanLoader } from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_plan_loader_rv6";
const OTHER_ORG = "org_plan_loader_rv6_other";
const PROJECT = "project_plan_loader_rv6";
const BEHAVIOR_REVISION = "br_plan_loader_rv6";
const PERSONA_REVISION = "pr_plan_loader_rv6";
const D = `sha256:${"d".repeat(64)}` as Digest;

const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
  ],
};

function databaseName(): string {
  return `tanren_plan_loader_rv6_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5, $6::jsonb)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D, JSON.stringify(ACCEPTANCE)],
  );
}

describeDb("rv-6 A2 acceptance plan loader — real Postgres, tenant-scoped", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let loader: PgAcceptancePlanLoader;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    loader = new PgAcceptancePlanLoader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("runs the read as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("loads and compiles the stored acceptance spec into the executable plan", async () => {
    const plans = await loader.loadPlans({ orgId: ORG, behaviorRevisionIds: [BEHAVIOR_REVISION] });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.behaviorRevisionId).toBe(BEHAVIOR_REVISION);
    expect(plans[0]?.requiredSurfaces).toEqual(["api"]);
    expect(plans[0]?.httpProbes).toEqual([{ probeId: "p1", method: "GET", path: "/health" }]);
    expect(plans[0]?.assertions).toEqual([
      { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
      { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
    ]);
  });

  it("org isolation: another org's scope sees ZERO rows and fails loud", async () => {
    await expect(
      loader.loadPlans({ orgId: OTHER_ORG, behaviorRevisionIds: [BEHAVIOR_REVISION] }),
    ).rejects.toBeInstanceOf(BehaviorRevisionNotFoundError);
  });
});
