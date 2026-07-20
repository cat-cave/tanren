// SP-3 — real-Postgres RLS round-trip for PgProofSubstrate over migration 0035's
// proof tables. Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL.
// Proves: ingest→construct→persist→verify, a persisted bundle re-verifies, a
// tampered member fails verify, and cross-org isolation (org B sees nothing;
// deny-by-default under the runtime role).
//
//   DATABASE_URL=postgres://tanren:tanren@localhost:5432/tanren TANREN_RLS_DB_TEST=1 \
//     corepack pnpm exec vitest run services/orchestrator/tests/pgProofSubstrate.rls.integration.test.ts
import { generateKeyPairSync } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { PgProofSubstrate } from "../src/engine/cas/pgProofSubstrate.js";
import type { BundleBindings, Digest, ProofBundleSealed } from "../src/engine/contracts/cas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const SIGNING_REF = "credential/proof-substrate/platform/test-ed25519";

const ORG_A = "org_sp3_a";
const ORG_B = "org_sp3_b";
const PROJECT_A = "project_sp3_a";
const PROJECT_B = "project_sp3_b";

function dbName(): string {
  return `tanren_sp3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

function secretsWithKey(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  const { privateKey } = generateKeyPairSync("ed25519");
  void store.put({ ref: SIGNING_REF, value: privateKey.export({ type: "pkcs8", format: "pem" }) as string });
  return store;
}

describeDb("PgProofSubstrate RLS (SP-3 proof bundle round-trip)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let substrate: PgProofSubstrate;
  let artifactDigest: Digest;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb),
              ($2, 'oidc', $2, $2, $2, '{"version":1}'::jsonb)`,
      [ORG_A, ORG_B],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, $1, 'https://example.com/a.git', 'main', 'runner:v0', $2, '{}'::jsonb),
              ($3, $3, 'https://example.com/b.git', 'main', 'runner:v0', $4, '{}'::jsonb)`,
      [PROJECT_A, ORG_A, PROJECT_B, ORG_B],
    );

    substrate = new PgProofSubstrate(runtimePool, secretsWithKey(), { signingKeyRef: SIGNING_REF });

    // The attested artifact (bindings.artifactDigest) must exist in cas_artifacts.
    const cas = new PgCasByteStore(runtimePool);
    const artifactRef = await cas.put({
      orgId: ORG_A,
      bytes: new TextEncoder().encode("sp3-attested-artifact"),
      mediaType: "application/octet-stream",
    });
    artifactDigest = artifactRef.digest;
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

  function bindings(): BundleBindings {
    return {
      integrationNodeId: "inode_sp3",
      memberSetHash: `sha256:${"a".repeat(64)}`,
      preparedHeadSha: "head-sha",
      jjTreeId: `sha256:${"b".repeat(64)}`,
      artifactDigest,
      expectedMainSha: "main-sha",
      issuedAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-07-20T01:00:00.000Z",
      nonce: `nonce-${Math.random()}`,
    };
  }

  async function constructAndPersist(): Promise<ProofBundleSealed> {
    const members = await substrate.ingestUnits({
      orgId: ORG_A,
      projectId: PROJECT_A,
      drafts: [
        { kind: "native_ci_tier", verdict: "passed", subjectId: "tier1", body: { tier: "tier1" } },
        { kind: "test", verdict: "passed", subjectId: "suite", body: { suite: "unit" } },
      ],
    });
    const bundle = await substrate.constructBundle({
      orgId: ORG_A,
      projectId: PROJECT_A,
      members,
      bindings: bindings(),
    });
    await substrate.persistBundle(bundle);
    return bundle;
  }

  it("ingest→construct→persist→verify round-trip persists rows and re-verifies", async () => {
    const bundle = await constructAndPersist();

    // A persisted bundle re-verifies valid.
    expect((await substrate.verify(bundle)).valid).toBe(true);

    // The rows landed under org A scope.
    const bundleRow = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query<{ id: string; signing_key_id: string }>(
        "SELECT id, signing_key_id FROM proof_bundles WHERE bundle_digest = $1",
        [bundle.bundleDigest],
      ),
    );
    expect(bundleRow.rowCount).toBe(1);
    expect(bundleRow.rows[0]?.signing_key_id).toBe(bundle.signingKeyId);

    const unitRows = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query("SELECT proof_unit_digest FROM proof_bundle_units WHERE bundle_id = $1", [bundle.bundleId]),
    );
    expect(unitRows.rowCount).toBe(2);

    // Idempotent re-persist does not throw and does not duplicate.
    await substrate.persistBundle(bundle);
    const again = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query("SELECT id FROM proof_bundles WHERE bundle_digest = $1", [bundle.bundleDigest]),
    );
    expect(again.rowCount).toBe(1);
  });

  it("a tampered member fails verify even after a genuine seal", async () => {
    const bundle = await constructAndPersist();
    const tampered: ProofBundleSealed = {
      ...bundle,
      members: bundle.members.map((m, i) => (i === 0 ? { ...m, verdict: "failed" } : m)),
    };
    const result = await substrate.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/proof root/u);
  });

  it("cross-org isolation: org B and the unscoped runtime role see zero proof rows", async () => {
    const bundle = await constructAndPersist();

    // Org B scope cannot see org A's bundle.
    const crossBundle = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT id FROM proof_bundles WHERE bundle_digest = $1", [bundle.bundleDigest]),
    );
    expect(crossBundle.rowCount).toBe(0);
    const crossUnits = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT proof_unit_digest FROM proof_units"),
    );
    expect(crossUnits.rowCount).toBe(0);

    // Unscoped runtime SELECT sees zero rows (deny-by-default).
    const denied = await runtimePool.query("SELECT id FROM proof_bundles");
    expect(denied.rowCount).toBe(0);
  });
});
