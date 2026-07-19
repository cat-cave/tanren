// ds-0 — DesignSystemReleaseStore RLS: same-org round-trip + cross-org denial.
// Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL, mirroring
// pgCasByteStore.rls.integration.test.ts. Proves a valid DesignContractV2's digest
// persists org-scoped on a release and round-trips, while org B / the unscoped
// runtime pool see ZERO of org A's rows (deny-by-default RLS + FORCE).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { normalizeDesignContract } from "../src/engine/design/designContract.js";
import { designContractV2Digest, migrateDesignContractV1ToV2 } from "../src/engine/design/system/designContractV2.js";
import { DesignSystemNotFoundError, DesignSystemReleaseStore } from "../src/engine/design/system/designSystemStore.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_ds0_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_ds0_a";
const ORG_B = "org_ds0_b";

const contract = migrateDesignContractV1ToV2(
  normalizeDesignContract({ version: 1, domain: "saas-web", identity: "calm console", intent: "never surprises" }),
);
const contractDigest = designContractV2Digest(contract);

describeDb("DesignSystemReleaseStore RLS (ds-0 design foundation)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

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

  it("POSITIVE — a valid contract digest persists org-scoped on a release and round-trips", async () => {
    const store = new DesignSystemReleaseStore(runtimePool);
    await store.createSystem({ orgId: ORG_A, id: "system_a", slug: "console", name: "Console DS" });
    const created = await store.createRelease({
      orgId: ORG_A,
      id: "release_a1",
      designSystemId: "system_a",
      version: 1,
      contractId: "contract_a",
      contractVersion: contract.version,
      contractDigest,
      manifestSchemaVersion: 1,
      createdBy: "actor_a",
    });
    expect(created.contractDigest).toBe(contractDigest);

    const got = await store.getRelease(ORG_A, "release_a1");
    expect(got.releaseId).toBe("release_a1");
    expect(got.contractDigest).toBe(contractDigest);
    // The persisted digest re-derives from the original contract (round-trip).
    expect(got.contractDigest).toBe(designContractV2Digest(contract));

    const latest = await store.getLatestRelease(ORG_A, "system_a");
    expect(latest?.releaseId).toBe("release_a1");
  });

  it("publishRelease — transitions a draft to published (provenance + canonical artifact) org-scoped", async () => {
    const store = new DesignSystemReleaseStore(runtimePool);
    await store.createSystem({ orgId: ORG_A, id: "system_pub", slug: "pub", name: "Publishable DS" });
    await store.createRelease({
      orgId: ORG_A,
      id: "release_pub1",
      designSystemId: "system_pub",
      version: 1,
      contractId: "contract_pub",
      contractVersion: contract.version,
      contractDigest,
      manifestSchemaVersion: 1,
      createdBy: "actor_a",
    });
    const artifactDigest = `sha256:${"c".repeat(64)}`;
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query(
        `INSERT INTO design_artifacts
           (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size)
         VALUES ($1, $2, $3, $4, 'application/vnd.tanren.design.manifest+json', 1, $5, 128)`,
        [ORG_A, "artifact_pub1", "system_pub", artifactDigest, `objects/${artifactDigest.slice(7)}`],
      ),
    );

    const published = await store.publishRelease({
      orgId: ORG_A,
      releaseId: "release_pub1",
      canonicalArtifactId: "artifact_pub1",
      publishedBy: "operator_pub",
    });
    expect(published.state).toBe("published");
    expect(published.canonicalArtifactId).toBe("artifact_pub1");

    // Provenance columns satisfy the `_published_check` invariant.
    const row = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      client.query<{ state: string; published_by: string | null; published_at: Date | null }>(
        "SELECT state, published_by, published_at FROM design_system_releases WHERE id = $1",
        ["release_pub1"],
      ),
    );
    expect(row.rows[0]?.state).toBe("published");
    expect(row.rows[0]?.published_by).toBe("operator_pub");
    expect(row.rows[0]?.published_at).not.toBeNull();

    // A second publish is not a legal source (already published) — never re-stamps.
    await expect(
      store.publishRelease({
        orgId: ORG_A,
        releaseId: "release_pub1",
        canonicalArtifactId: "artifact_pub1",
        publishedBy: "operator_pub",
      }),
    ).rejects.toBeInstanceOf(DesignSystemNotFoundError);
  });

  it("publishRelease NEGATIVE CONTROL — org B cannot publish org A's release (RLS hides the row)", async () => {
    const store = new DesignSystemReleaseStore(runtimePool);
    await store.createSystem({ orgId: ORG_A, id: "system_pub2", slug: "pub2", name: "Publishable DS 2" });
    await store.createRelease({
      orgId: ORG_A,
      id: "release_pub2",
      designSystemId: "system_pub2",
      version: 1,
      contractId: "contract_pub2",
      contractVersion: contract.version,
      contractDigest,
      manifestSchemaVersion: 1,
      createdBy: "actor_a",
    });
    await expect(
      store.publishRelease({
        orgId: ORG_B,
        releaseId: "release_pub2",
        canonicalArtifactId: "artifact_pub1",
        publishedBy: "attacker",
      }),
    ).rejects.toBeInstanceOf(DesignSystemNotFoundError);
    // Org A's release is untouched — still a draft.
    const still = await store.getRelease(ORG_A, "release_pub2");
    expect(still.state).toBe("draft");
  });

  it("NEGATIVE CONTROL — org B and the unscoped runtime pool see ZERO of org A's rows", async () => {
    const store = new DesignSystemReleaseStore(runtimePool);
    // Cross-org read via the store surfaces as not-found (RLS hides the row).
    await expect(store.getRelease(ORG_B, "release_a1")).rejects.toBeInstanceOf(DesignSystemNotFoundError);
    expect(await store.getLatestRelease(ORG_B, "system_a")).toBeNull();

    // Scoped org B raw SELECT sees zero rows.
    const crossReleases = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT id FROM design_system_releases WHERE design_system_id = $1", ["system_a"]),
    );
    expect(crossReleases.rowCount).toBe(0);
    const crossSystems = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query("SELECT id FROM design_systems"),
    );
    expect(crossSystems.rowCount).toBe(0);

    // Unscoped runtime pool (no app.current_org_id GUC) sees zero rows — FORCE RLS.
    const deniedReleases = await runtimePool.query("SELECT id FROM design_system_releases");
    expect(deniedReleases.rowCount).toBe(0);
    const deniedSystems = await runtimePool.query("SELECT id FROM design_systems");
    expect(deniedSystems.rowCount).toBe(0);
  });
});
