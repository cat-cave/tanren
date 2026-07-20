// cspell:ignore rels
/**
 * in-15 real-Postgres proofs for the appEnvHash proof gate against migration 0043.
 * Opt-in: TANREN_RLS_DB_TEST=1 with a reachable DATABASE_URL.
 *
 * Proves, on the exact schema the deploy path consumes: a correctly-materialized
 * (in-14) production binding VERIFIES; a tampered plain env value → hash mismatch →
 * the gate BLOCKS (tamper-evident); a revoked scoped secret → unresolvable → BLOCKS;
 * a binding with no ready generation → BLOCKS (missing); and the gate is org-scoped
 * (a cross-org caller sees zero ready bindings — a clean no-op — and cannot verify
 * another org's binding).
 */
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { generationSecretRef } from "../src/engine/contracts/integrationSecretStore.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import { materializeBinding, type ResolvedBinding } from "../src/engine/integrations/bindingMaterializer.js";
import {
  assertReadyProjectBindingProofs,
  BindingAppEnvProofFailedError,
  verifyBindingAppEnvProof,
  verifyReadyProjectBindingProofs,
  type ProjectBindingProofScope,
} from "../src/engine/integrations/bindingAppEnvProof.js";
import { systemActor } from "../src/engine/state/actor.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG_A = "org_in15_a";
const ORG_B = "org_in15_b";
const PROJECT_A = "project_in15_a";
const PROJECT_B = "project_in15_b";
const PROVIDER = "slack";
const CONN_A = "conn-in15-a";
const GRANT_A = "grant-in15-a";
const REQ_A = "req-in15-a";
const BIND_A = "bind-in15-a";
const CRED_A = `secret://org/${ORG_A}/slack/connection/${CONN_A}/token`;
const TOKEN_MATERIAL = "xoxb-in15-secret-material";
const PLAIN_CHANNEL = "C-in15-plaintext";
const SCOPE_A: ProjectBindingProofScope = { orgId: ORG_A, projectId: PROJECT_A, environment: "production" };
const PROJECT_TOKEN_REF = `secret://org/${ORG_A}/project/${PROJECT_A}/binding/${BIND_A}/env/SLACK_BOT_TOKEN`;

function dbName(): string {
  return `tanren_in15_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
             ARRAY['chat:write']::text[], '{}'::jsonb, 'integration-catalog.v2', 'consent.test',
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

function buildResolved(): ResolvedBinding {
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
    externalResourceId: "C-1000",
    externalResourceName: "general",
    ownership: "created",
    teardownPolicy: "delete",
    // Empty scopes on purpose: scopesOf defaults them to ["runtime"] at WRITE time,
    // so the WHOLE suite exercises the record==stored==verify scope alignment — the
    // "verifies" test below would false-fail if record hashed raw scopes.
    outputs: [
      {
        logicalKey: "SLACK_BOT_TOKEN",
        secret: true,
        required: true,
        scopes: [],
        secretSource: { ref: CRED_A, generation: 1 },
      },
      { logicalKey: "SLACK_CHANNEL_ID", secret: false, required: true, scopes: [], plainValue: PLAIN_CHANNEL },
    ],
  };
}

describeDb("in-15 appEnvHash proof gate — real Postgres", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  const backing = new InMemorySecretStore();
  const secrets = new GenerationAddressedIntegrationSecretStore(backing);

  async function updatePlain(value: string): Promise<void> {
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query(
        `UPDATE project_app_env SET plain_value = $1, updated_at = now()
          WHERE org_id = $2 AND project_id = $3 AND environment = 'production' AND key = 'SLACK_CHANNEL_ID'`,
        [value, ORG_A, PROJECT_A],
      ),
    );
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
    await backing.put({ ref: generationSecretRef(CRED_A, 1), value: TOKEN_MATERIAL });

    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      materializeBinding(client, secrets, buildResolved(), systemActor),
    );
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

  it("verifies a correctly-materialized production binding (scopesOf-defaulted scopes round-trip)", async () => {
    const { verdict, contracts } = await runWithOrgScope(runtimePool, ORG_A, async (client) => ({
      verdict: await verifyBindingAppEnvProof(client, secrets, SCOPE_A, BIND_A),
      contracts: await assertReadyProjectBindingProofs(client, secrets, SCOPE_A),
    }));
    expect(verdict.status).toBe("verified");
    expect(contracts).toHaveLength(1);
    const contract = contracts[0];
    expect(contract?.appEnvHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(contract?.outputs.map((o) => o.logicalKey)).toEqual(["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]);
    // Never a value in the frozen contract — only the immutable shape + hash.
    expect(JSON.stringify(contracts)).not.toContain(TOKEN_MATERIAL);
    expect(JSON.stringify(contracts)).not.toContain(PLAIN_CHANNEL);
  });

  it("BLOCKS a tampered plain env value — hash mismatch, gate throws (tamper-evident)", async () => {
    await updatePlain("C-HACKED");
    try {
      const verdict = await runWithOrgScope(runtimePool, ORG_A, (client) =>
        verifyBindingAppEnvProof(client, secrets, SCOPE_A, BIND_A),
      );
      expect(verdict.status).toBe("hash_mismatch");

      await expect(
        runWithOrgScope(runtimePool, ORG_A, (client) => assertReadyProjectBindingProofs(client, secrets, SCOPE_A)),
      ).rejects.toBeInstanceOf(BindingAppEnvProofFailedError);
    } finally {
      await updatePlain(PLAIN_CHANNEL);
    }
    // Restored → verifies again.
    const restored = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      verifyBindingAppEnvProof(client, secrets, SCOPE_A, BIND_A),
    );
    expect(restored.status).toBe("verified");
  });

  it("BLOCKS when the scoped secret can no longer be resolved (revoked)", async () => {
    await backing.delete(generationSecretRef(PROJECT_TOKEN_REF, 1));
    try {
      const verdict = await runWithOrgScope(runtimePool, ORG_A, (client) =>
        verifyBindingAppEnvProof(client, secrets, SCOPE_A, BIND_A),
      );
      expect(verdict.status).toBe("unresolved_secret");
      await expect(
        runWithOrgScope(runtimePool, ORG_A, (client) => assertReadyProjectBindingProofs(client, secrets, SCOPE_A)),
      ).rejects.toBeInstanceOf(BindingAppEnvProofFailedError);
    } finally {
      await backing.put({ ref: generationSecretRef(PROJECT_TOKEN_REF, 1), value: TOKEN_MATERIAL });
    }
  });

  it("BLOCKS a binding with no ready generation (missing) and is org-scoped (cross-org zero)", async () => {
    const absent = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      verifyBindingAppEnvProof(client, secrets, SCOPE_A, "bind-nonexistent"),
    );
    expect(absent.status).toBe("missing_generation");

    // Cross-org: ORG_B sees zero ready bindings for PROJECT_A → clean no-op, and
    // cannot verify ORG_A's binding.
    const scopeB: ProjectBindingProofScope = { orgId: ORG_B, projectId: PROJECT_A, environment: "production" };
    const crossOrg = await runWithOrgScope(runtimePool, ORG_B, async (client) => ({
      ready: await verifyReadyProjectBindingProofs(client, secrets, scopeB),
      contracts: await assertReadyProjectBindingProofs(client, secrets, scopeB),
      binding: await verifyBindingAppEnvProof(client, secrets, scopeB, BIND_A),
    }));
    expect(crossOrg.ready).toEqual([]);
    expect(crossOrg.contracts).toEqual([]);
    expect(crossOrg.binding.status).toBe("missing_generation");
  });

  it("BLOCKS a superseded-generation leftover row not covered by the verified binding (coverage gap)", async () => {
    // Shrink BIND_A's output set (drop SLACK_CHANNEL_ID) → mints gen 2 with TOKEN only.
    // The dropped key's project_app_env row stays at gen 1 (an FK-valid orphan that
    // env-attach would still ship).
    const tokenOnly = { ...buildResolved(), outputs: [buildResolved().outputs[0]!] };
    await runWithOrgScope(runtimePool, ORG_A, (client) => materializeBinding(client, secrets, tokenOnly, systemActor));

    // Per-binding STILL verifies (gen 2 = TOKEN only) — the gap is project-wide.
    const perBinding = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      verifyReadyProjectBindingProofs(client, secrets, SCOPE_A),
    );
    expect(perBinding.map((v) => v.status)).toEqual(["verified"]);

    // The whole-project coverage assertion BLOCKS on the orphan gen-1 CHANNEL row.
    const err = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      assertReadyProjectBindingProofs(client, secrets, SCOPE_A),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BindingAppEnvProofFailedError);
    expect((err as BindingAppEnvProofFailedError).failures.some((f) => f.status === "unverified_app_env_rows")).toBe(
      true,
    );

    // Restore: re-materialize both keys → CHANNEL upserts forward to the current gen,
    // no orphan remains, coverage passes again.
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      materializeBinding(client, secrets, buildResolved(), systemActor),
    );
    const restored = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      assertReadyProjectBindingProofs(client, secrets, SCOPE_A),
    );
    expect(restored).toHaveLength(1);
  });
});
