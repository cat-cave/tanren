// cspell:ignore rels
/**
 * in-14 real-Postgres proofs for the BindingMaterializer against migration 0043.
 * Opt-in: TANREN_RLS_DB_TEST=1 with a reachable DATABASE_URL.
 *
 * Proves: a resolved binding materializes an immutable generation +
 * `integration_binding_env` shape + provisioned `project_app_env` + a project-
 * scoped least-privilege Vault ref per secret; identical content is idempotent
 * (same generation); changed content mints the next generation; a missing secret
 * fails closed with no partial write; the rows are org-scoped (cross-org zero);
 * and the live deploy-path reconcile re-materializes ready bindings idempotently
 * and fails closed on a revoked secret.
 */
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../src/engine/contracts/integrationSecretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import {
  BindingSecretUnresolvedError,
  materializeBinding,
  type ResolvedBinding,
} from "../src/engine/integrations/bindingMaterializer.js";
import { materializeReadyProjectBindings } from "../src/engine/postMerge/materializeProjectBindings.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_in14_a";
const ORG_B = "org_in14_b";
const PROJECT_A = "project_in14_a";
const PROJECT_B = "project_in14_b";
const PROVIDER = "slack";
const CONN_A = "conn-in14-a";
const GRANT_A = "grant-in14-a";
const REQ_A = "req-in14-a";
const BIND_A = "bind-in14-a";
const CRED_A = `secret://org/${ORG_A}/slack/connection/${CONN_A}/token`;
const TOKEN_MATERIAL = "xoxb-in14-secret-material";

function dbName(): string {
  return `tanren_in14_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function seedTenant(owner: Pool, orgId: string, projectId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
    [projectId, orgId],
  );
}

async function seedConnectionAndRequirement(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  projectId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO org_integration_connections
       (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name,
        principal_metadata, health, status, current_auth_generation, owner_id)
     VALUES ($1, $2, $3, 'team-a', 'organization', 'team-a', '{}'::jsonb, 'healthy', 'active', 1, 'admin-a')`,
    [orgId, CONN_A, PROVIDER],
  );
  await client.query(
    `INSERT INTO org_integration_connection_auth_generations
       (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
     VALUES ($1, $2, $3, 1, $4, 'bot_token', 'active')`,
    [orgId, PROVIDER, CONN_A, CRED_A],
  );
  await client.query(
    `INSERT INTO org_integration_grants
       (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
     VALUES ($1, $2, $3, $4, 'product', 'production', 1, 'active')`,
    [orgId, GRANT_A, PROVIDER, CONN_A],
  );
  await client.query(
    `INSERT INTO org_integration_grant_generations
       (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations,
        provider_scopes, resource_constraints, policy_revision, consent_revision,
        consent_actor_id, consented_at, status)
     VALUES ($1, $2, $3, $4, 1, ARRAY['messaging']::text[], ARRAY['bind']::text[],
             ARRAY['chat:write']::text[], '{}'::jsonb, 'integration-catalog.v3', 'consent.test',
             'admin-a', now(), 'active')`,
    [orgId, PROVIDER, CONN_A, GRANT_A],
  );
  await client.query(
    `INSERT INTO integration_requirements
       (org_id, id, project_id, capability, plane, direction, desired_state,
        source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, 'messaging.send', 'product', 'outbound', '{}'::jsonb,
             'design_contract', 'design-a', $4, 'policy-v1', 'release_required')`,
    [orgId, REQ_A, projectId, `sha256:${"a".repeat(64)}`],
  );
}

function buildResolved(channelId: string): ResolvedBinding {
  return {
    orgId: ORG_A,
    projectId: PROJECT_A,
    requirementId: REQ_A,
    environment: "production",
    bindingId: BIND_A,
    providerKind: PROVIDER,
    connectionId: CONN_A,
    authGeneration: 1,
    grantId: GRANT_A,
    grantGeneration: 1,
    adapterVersion: "slack.v1",
    externalResourceId: channelId,
    externalResourceName: "general",
    ownership: "created",
    teardownPolicy: "delete",
    outputs: [
      {
        logicalKey: "SLACK_BOT_TOKEN",
        secret: true,
        required: true,
        scopes: ["runtime"],
        secretSource: { ref: CRED_A, generation: 1 },
      },
      { logicalKey: "SLACK_CHANNEL_ID", secret: false, required: true, scopes: ["runtime"], plainValue: channelId },
    ],
  };
}

describeDb("in-14 BindingMaterializer — real Postgres", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  const backing = new InMemorySecretStore();
  const secrets = new GenerationAddressedIntegrationSecretStore(backing);

  async function generationCount(): Promise<number> {
    const rows = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM integration_binding_generations WHERE org_id = $1 AND binding_id = $2",
        [ORG_A, BIND_A],
      ),
    );
    return (rows.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await seedTenant(ownerPool, ORG_A, PROJECT_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B);
    await runWithOrgScope(runtimePool, ORG_A, (client) => seedConnectionAndRequirement(client, ORG_A, PROJECT_A));

    // The connection credential the scoped project secret is minted FROM.
    await backing.put({ ref: generationSecretRef(CRED_A, 1), value: TOKEN_MATERIAL });
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("materializes a resolved binding into a generation + scoped Vault ref + app env", async () => {
    const result = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      materializeBinding(client, secrets, buildResolved("C-1000"), systemActor),
    );
    expect(result.reused).toBe(false);
    expect(result.generation).toBe(1);
    expect(result.desiredStateHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.materializedKeys).toEqual(["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]);

    const state = await runWithOrgScope(runtimePool, ORG_A, async (client) => ({
      env: (
        await client.query(
          "SELECT key, classification FROM integration_binding_env WHERE org_id=$1 AND binding_id=$2 ORDER BY key",
          [ORG_A, BIND_A],
        )
      ).rows,
      app: (
        await client.query(
          `SELECT key, value_ref, plain_value, secret_generation, source, binding_generation
             FROM project_app_env WHERE org_id=$1 AND project_id=$2 AND environment='production' ORDER BY key`,
          [ORG_A, PROJECT_A],
        )
      ).rows,
      binding: (
        await client.query("SELECT current_generation, status FROM integration_bindings WHERE org_id=$1 AND id=$2", [
          ORG_A,
          BIND_A,
        ])
      ).rows[0],
    }));

    expect(state.env).toEqual([
      { key: "SLACK_BOT_TOKEN", classification: "secret" },
      { key: "SLACK_CHANNEL_ID", classification: "non_secret" },
    ]);
    expect(state.binding).toEqual({ current_generation: 1, status: "ready" });

    const token = state.app.find((r) => (r as { key: string }).key === "SLACK_BOT_TOKEN") as {
      value_ref: string;
      plain_value: string | null;
      secret_generation: number;
      source: string;
      binding_generation: number;
    };
    expect(token.source).toBe("provisioned");
    expect(token.plain_value).toBeNull();
    expect(token.secret_generation).toBe(1);
    expect(token.binding_generation).toBe(1);
    // Project-scoped, least-privilege ref — NOT the org-wide connection credential.
    expect(token.value_ref).toBe(
      `secret://org/${ORG_A}/project/${PROJECT_A}/binding/${BIND_A}/env/SLACK_BOT_TOKEN/g/1`,
    );
    // The scoped secret resolves to the source material (a real copy was minted).
    const resolvedValue = await secrets.getExact({ ref: token.value_ref, generation: 1 });
    expect(resolvedValue).toBe(TOKEN_MATERIAL);

    const channel = state.app.find((r) => (r as { key: string }).key === "SLACK_CHANNEL_ID") as {
      plain_value: string | null;
      value_ref: string | null;
    };
    expect(channel.value_ref).toBeNull();
    expect(channel.plain_value).toBe("C-1000");
  });

  it("is idempotent for identical content — same generation, no new generation row", async () => {
    const result = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      materializeBinding(client, secrets, buildResolved("C-1000"), systemActor),
    );
    expect(result.reused).toBe(true);
    expect(result.generation).toBe(1);
    expect(await generationCount()).toBe(1);
  });

  it("mints the next generation when content changes", async () => {
    const result = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      materializeBinding(client, secrets, buildResolved("C-2000"), systemActor),
    );
    expect(result.reused).toBe(false);
    expect(result.generation).toBe(2);
    expect(await generationCount()).toBe(2);

    const app = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query(
        `SELECT key, plain_value, binding_generation FROM project_app_env
          WHERE org_id=$1 AND project_id=$2 AND key='SLACK_CHANNEL_ID'`,
        [ORG_A, PROJECT_A],
      ),
    );
    expect(app.rows[0]).toEqual({ key: "SLACK_CHANNEL_ID", plain_value: "C-2000", binding_generation: 2 });
  });

  it("fails closed with no partial write when a required secret is unresolvable", async () => {
    const before = await generationCount();
    const broken = buildResolved("C-2000");
    const badOutputs = broken.outputs.map((o) =>
      o.secret ? { ...o, secretSource: { ref: "secret://absent/token", generation: 1 } } : o,
    );
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        materializeBinding(client, secrets, { ...broken, outputs: badOutputs }, systemActor),
      ),
    ).rejects.toBeInstanceOf(BindingSecretUnresolvedError);
    expect(await generationCount()).toBe(before);
  });

  it("is org-scoped — another org sees zero binding + app-env rows", async () => {
    const seenByB = await runWithOrgScope(runtimePool, ORG_B, async (client) => ({
      env: (await client.query("SELECT key FROM integration_binding_env WHERE binding_id=$1", [BIND_A])).rows.length,
      app: (await client.query("SELECT key FROM project_app_env WHERE project_id=$1", [PROJECT_A])).rows.length,
    }));
    expect(seenByB).toEqual({ env: 0, app: 0 });

    const unscoped = await runtimePool.query("SELECT binding_id FROM integration_binding_generations");
    expect(unscoped.rows.length).toBe(0);
  });

  it("the deploy-path reconcile re-materializes ready bindings idempotently, then fails closed on a revoked secret", async () => {
    const reconciled = await materializeReadyProjectBindings({
      pool: runtimePool,
      secrets,
      orgId: ORG_A,
      projectId: PROJECT_A,
      environment: "production",
      actor: systemActor,
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ bindingId: BIND_A, generation: 2, reused: true });
    expect(await generationCount()).toBe(2);

    // Revoke the connection credential → the pre-deploy guard must fail LOUD.
    await backing.delete(generationSecretRef(CRED_A, 1));
    await expect(
      materializeReadyProjectBindings({
        pool: runtimePool,
        secrets,
        orgId: ORG_A,
        projectId: PROJECT_A,
        environment: "production",
        actor: systemActor,
      }),
    ).rejects.toBeInstanceOf(BindingSecretUnresolvedError);
  });
});
