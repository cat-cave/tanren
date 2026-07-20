import { Pool } from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import type { ActorContext } from "../src/auth/schemas.js";
import type { AuthoringAuthorer } from "../src/engine/contracts/authoringKernel.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  IntegrationFragmentStore,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSpec,
} from "../src/engine/integrations/fragments/index.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes } from "../src/routes/integrations/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appRole = "tanren_app";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const orgA = "org_in7_a";
const orgB = "org_in7_b";
const projectA = "project_in7_a";
const adminActor: ActorContext = {
  userId: "user_in7_admin",
  orgId: orgA,
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const slackSpec: IntegrationFragmentSpec = {
  capability: "messaging.send",
  providerKind: "slack",
  plane: "product",
  version: "1.0.0",
};

function draft(spec: IntegrationFragmentSpec): IntegrationFragmentDraft {
  return {
    spec,
    definition: {
      direction: "outbound",
      criticality: "release_required",
      bindingOutputs: [
        {
          kind: "product.messaging.bot_token_ref",
          logicalKey: "PROVIDER_TOKEN",
          classification: "secret_ref",
          required: true,
        },
      ],
      operations: ["send"],
      validationPlan: {
        version: 1,
        preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
        postDeploy: { liveStimulus: true, independentObservation: true },
        negativeControls: ["missing-scope"],
      },
    },
  };
}

function fragmentConfig() {
  return {
    apiVersion: "tanren.dev/integration-fragments/v1" as const,
    schemaVersion: 1 as const,
    fragments: [slackSpec],
  };
}

function databaseName(): string {
  return `tanren_in7_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function app(pool: Pool): Hono<ActorContextEnv> {
  const writer: AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft> = {
    async author(input) {
      return draft(input.spec);
    },
  };
  const result = new Hono<ActorContextEnv>();
  result.use("*", async (c, next) => {
    c.set("actor", adminActor);
    await next();
  });
  result.route(
    "/orgs",
    createIntegrationRoutes({ pool, secrets: new InMemorySecretStore(), integrationFragmentAuthorer: () => writer }),
  );
  return result;
}

describeDb("in-7 integration fragment RLS", () => {
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

  it("drives the production derive HTTP seam (F2 authors the missing definition), then proves org isolation + durable integration.author.* events", async () => {
    const store = new IntegrationFragmentStore(runtimePool);
    const response = await app(runtimePool).request(`/orgs/${orgA}/projects/${projectA}/integrations/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: fragmentConfig() }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; snapshot: Array<{ providerKind: string }> };
    expect(payload.ok).toBe(true);
    expect(payload.snapshot.map((entry) => entry.providerKind)).toEqual(["slack"]);

    expect((await store.listValidated(orgA)).map((row) => row.draft.spec.providerKind)).toEqual(["slack"]);
    expect(await store.listValidated(orgB)).toEqual([]);

    const crossOrg = await runWithOrgScope(runtimePool, orgB, (client) =>
      client.query("SELECT id FROM integration_fragments"),
    );
    expect(crossOrg.rowCount).toBe(0);
    expect((await runtimePool.query("SELECT id FROM integration_fragments")).rowCount).toBe(0);

    // The events FK (migration 0096 seeded event_types) accepted the real appends.
    const events = await runWithOrgScope(runtimePool, orgA, (client) =>
      client.query<{ event_type: string }>(
        `SELECT event_type FROM events
          WHERE org_id = $1 AND project_id = $2 AND event_type LIKE 'integration.author.%'
          ORDER BY id`,
        [orgA, projectA],
      ),
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "integration.author.started",
      "integration.author.attempt",
      "integration.author.succeeded",
    ]);
  });
});
