// PG-gated tenant proof for the integration-events read surface.
// Run with TANREN_RLS_DB_TEST=1; the ordinary test gate skips this suite.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes } from "../src/routes/integrations/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_in_events_a";
const ORG_B = "org_in_events_b";
const PROJECT_A = "project_in_events_a";
const PROJECT_B = "project_in_events_b";

function dbName(): string {
  return `tanren_integration_events_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(pool: Pool, orgId: string, projectId: string): Promise<void> {
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
  await runWithOrgScope(pool, orgId, () =>
    new PgEventStore(pool).append({
      projectId,
      orgId,
      eventType: "integration.resource.provisioned",
      payload: {
        requirementId: "provisioning:project:errors",
        providerKind: "sentry",
        externalResourceId: "resource-a",
        ownership: "created",
      },
    }),
  );
}

describeDb("integration-events HTTP read — org/project RLS boundary", () => {
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
    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);
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

  it("returns the scoped project's integration event and denies the foreign org", async () => {
    const actor: ActorContext = {
      userId: "operator-events-a",
      orgId: ORG_A,
      projectId: null,
      scopes: ["org:admin"],
      source: "local_dev",
    };
    const app = new Hono<ActorContextEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      return next();
    });
    app.route("/orgs", createIntegrationRoutes({ pool: appPool, secrets: new InMemorySecretStore() }));

    const scoped = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/integration-events`);
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as {
      projectId: string;
      events: Array<{ eventType: string; payload: { externalResourceId: string } }>;
    };
    expect(body.projectId).toBe(PROJECT_A);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      eventType: "integration.resource.provisioned",
      payload: { externalResourceId: "resource-a" },
    });

    const foreignOrg = await app.request(`/orgs/${ORG_B}/projects/${PROJECT_B}/integration-events`);
    expect(foreignOrg.status).toBe(403);
    expect(await foreignOrg.json()).toEqual({ error: "org_access_denied" });
  });
});
