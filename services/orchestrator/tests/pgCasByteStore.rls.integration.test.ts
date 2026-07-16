// in-2: PgCasByteStore over cas_artifacts — same-org put/get + cross-org deny.
// Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL.
// Uses an ephemeral migrated DB; prefers non-default host port when provided
// via DATABASE_URL (do not take the shared default stack when operators set an
// owned port).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import { parseDigest } from "../src/engine/contracts/cas.js";
import {
  canonicalRequirementBytes,
  goldenProductMessagingRequirement,
  INTEGRATION_REQUIREMENT_MEDIA_TYPE,
} from "../src/engine/contracts/integrationRequirement.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_in2_cas_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_in2_a";
const ORG_B = "org_in2_b";

describeDb("PgCasByteStore RLS (in-2 durable CAS)", () => {
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

  it("puts and gets an org-scoped requirement artifact; cross-org has() is false", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = canonicalRequirementBytes(goldenProductMessagingRequirement());
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });
    expect(ref.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(ref.byteSize).toBe(bytes.byteLength);

    const got = await store.get(ORG_A, ref.digest);
    expect(got.mediaType).toBe(INTEGRATION_REQUIREMENT_MEDIA_TYPE);
    expect(Buffer.from(got.bytes).equals(Buffer.from(bytes))).toBe(true);

    expect(await store.has(ORG_A, ref.digest)).toBe(true);
    // Same digest under org B scope sees nothing (RLS + composite PK).
    expect(await store.has(ORG_B, ref.digest)).toBe(false);

    // Raw runtime pool (no GUC) sees zero rows — deny-by-default.
    const denied = await runtimePool.query("SELECT digest FROM cas_artifacts");
    expect(denied.rowCount).toBe(0);

    // Scoped org B cannot read org A rows.
    const cross = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      client.query<{ digest: string }>("SELECT digest FROM cas_artifacts WHERE digest = $1", [ref.digest]),
    );
    expect(cross.rowCount).toBe(0);

    // Idempotent re-put does not throw.
    const again = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });
    expect(again.digest).toBe(ref.digest);
  });

  it("get throws CasArtifactNotFoundError for missing digest", async () => {
    const store = new PgCasByteStore(runtimePool);
    const missing = parseDigest(`sha256:${"ab".repeat(32)}`);
    await expect(store.get(ORG_A, missing)).rejects.toMatchObject({ name: "CasArtifactNotFoundError" });
  });
});
