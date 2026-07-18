// PG-gated tenant proof for the bh-14b self-healing funnel read surface.
// Run with TANREN_RLS_DB_TEST=1; the ordinary test gate skips this suite.

import { migrate } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { IssueLoopStore } from "../src/engine/repositories/issueLoops.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createSelfHealingRoutes } from "../src/routes/issueLoops/selfHealing.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_healing_a";
const ORG_B = "org_healing_b";
const PROJECT_A = "project_healing_a";
const PROJECT_B = "project_healing_b";

function dbName(): string {
  return `tanren_self_healing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withRole(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seedTenant(pool: Pool, orgId: string, projectId: string, state: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
  await pool.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
     VALUES ($1, $2, $3, 'issues', 'src')`,
    [`src_${orgId}`, orgId, projectId],
  );
  await IssueLoopStore.create(pool, {
    orgId,
    projectId,
    sourceId: `src_${orgId}`,
    externalKey: `key_${orgId}`,
    fingerprint: `fp_${orgId}`,
    severity: "high",
    state: state as never,
  });
}

function actorFor(orgId: string): ActorContext {
  return { userId: `operator_${orgId}`, orgId, projectId: null, scopes: ["org:admin"], source: "local_dev" };
}

function appFor(pool: Pool, actor: ActorContext): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    return next();
  });
  app.route("/v1/orgs", createSelfHealingRoutes({ pool }));
  return app;
}

describeDb("self-healing funnel HTTP read — org RLS boundary", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, database) });
    await seedTenant(ownerPool, ORG_A, PROJECT_A, "verifying");
    await seedTenant(ownerPool, ORG_B, PROJECT_B, "open");
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("runs as the restricted non-superuser app role", async () => {
    const row = (
      await appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      )
    ).rows[0];
    expect(row?.current_user).toBe("tanren_app");
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });

  it("counts only the caller org's loops and denies a foreign org", async () => {
    const scoped = await appFor(appPool, actorFor(ORG_A)).request(`/v1/orgs/${ORG_A}/self-healing/funnel`);
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as {
      funnel: { totalLoops: number; counts: { opened: number; deployed: number } };
    };
    // Only ORG_A's single loop is visible — ORG_B's loop is denied by RLS.
    expect(body.funnel.totalLoops).toBe(1);
    expect(body.funnel.counts.opened).toBe(1);
    expect(body.funnel.counts.deployed).toBe(1);

    const foreign = await appFor(appPool, actorFor(ORG_A)).request(`/v1/orgs/${ORG_B}/self-healing/funnel`);
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "org_access_denied" });
  });
});
