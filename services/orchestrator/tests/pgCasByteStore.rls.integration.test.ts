// in-2: PgCasByteStore over cas_artifacts — same-org put/get + cross-org deny.
// Gated behind TANREN_RLS_DB_TEST=1 + owner/superuser DATABASE_URL.
// Uses an ephemeral migrated DB; prefers non-default host port when provided
// via DATABASE_URL (do not take the shared default stack when operators set an
// owned port).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgCasByteStore, verifyStoredCasRow } from "../src/engine/cas/pgCasByteStore.js";
import { CasArtifactIntegrityError, contentDigestOf, parseDigest } from "../src/engine/contracts/cas.js";
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

  // ---- R2: stored-winner metadata + integrity re-hash ----
  // Each test below uses UNIQUE bytes so it owns a private content digest and
  // cannot contaminate (or be contaminated by) another test's row — important
  // because the corruption tests deliberately mutate stored rows out-of-band.

  /** Distinct synthetic payload → distinct content digest → isolated CAS row. */
  function uniqueBytes(label: string): Uint8Array {
    return new TextEncoder().encode(`in2-rls-${label}-${database}`);
  }

  it("put returns the STORED winner media type when same bytes are put under a different media type", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("stored-winner");
    const mediaTypeA = "application/vnd.tanren.integration-requirement.v1+json";
    const mediaTypeB = "application/vnd.tanren.integration-requirement.v1+json; profile=alt";

    const first = await store.put({ orgId: ORG_A, bytes, mediaType: mediaTypeA });
    expect(first.byteSize).toBe(bytes.byteLength);
    // R2: conflict (same digest) must NOT echo caller metadata — the first
    // writer's media type wins and is honestly returned.
    const second = await store.put({ orgId: ORG_A, bytes, mediaType: mediaTypeB });
    expect(second.mediaType).toBe(mediaTypeA);
    expect(second.byteSize).toBe(first.byteSize);
    expect(second.digest).toBe(first.digest);
    // And a get confirms the stored winner too.
    const got = await store.get(ORG_A, first.digest);
    expect(got.mediaType).toBe(mediaTypeA);
  });

  it("get detects corrupted inline_bytes as a typed CasArtifactIntegrityError (never false success)", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("get-corrupt");
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });

    // Corrupt the stored bytes out-of-band via the owner (BYPASSRLS), keeping the
    // digest key fixed. This simulates storage corruption / a miswrite.
    const corrupt = Buffer.from("corrupted-bytes-that-do-not-hash-to-the-requested-digest");
    await ownerPool.query(`UPDATE cas_artifacts SET inline_bytes = $1 WHERE org_id = $2 AND digest = $3`, [
      corrupt,
      ORG_A,
      ref.digest,
    ]);

    // R2: read path re-hashes stored bytes; corruption is a typed integrity error.
    await expect(store.get(ORG_A, ref.digest)).rejects.toMatchObject({
      name: "CasArtifactIntegrityError",
    });
  });

  it("put detects a corrupted existing row as a typed CasArtifactIntegrityError on the read-back", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("put-corrupt");
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });

    // Corrupt the existing row, then re-put the original bytes. The INSERT hits
    // ON CONFLICT DO NOTHING (row already present), so the read-back path must
    // catch the corruption rather than echo a false success.
    const corrupt = Buffer.from("corrupted-bytes-mismatched-against-digest-key");
    await ownerPool.query(`UPDATE cas_artifacts SET inline_bytes = $1 WHERE org_id = $2 AND digest = $3`, [
      corrupt,
      ORG_A,
      ref.digest,
    ]);

    await expect(
      store.put({ orgId: ORG_A, bytes, mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE }),
    ).rejects.toMatchObject({ name: "CasArtifactIntegrityError" });
  });

  // ---- R2 follow-up: byte_size exact-equality corruption (get + put-conflict) ----
  // These mutate ONLY the stored byte_size (inline bytes + digest stay consistent),
  // so the byte_size exact-equality check is the sole signal — proving the read
  // and read-back paths each validate byte_size, not just the content re-hash.

  it("get detects a stored byte_size mismatch as a typed CasArtifactIntegrityError", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("get-byte-size-mismatch");
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });

    // Corrupt only byte_size (bytes still hash to the digest). The read path's
    // byte_size exact-equality check must reject the mismatched metadata.
    await ownerPool.query(`UPDATE cas_artifacts SET byte_size = $1 WHERE org_id = $2 AND digest = $3`, [
      bytes.byteLength + 1,
      ORG_A,
      ref.digest,
    ]);

    await expect(store.get(ORG_A, ref.digest)).rejects.toMatchObject({
      name: "CasArtifactIntegrityError",
    });
  });

  it("put detects a stored byte_size mismatch on the read-back as a typed CasArtifactIntegrityError", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("put-byte-size-mismatch");
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });

    // Corrupt byte_size, then re-put the original bytes. INSERT hits ON CONFLICT
    // DO NOTHING (row already present), so the read-back path must catch the
    // mismatched byte_size rather than echo a false success.
    await ownerPool.query(`UPDATE cas_artifacts SET byte_size = $1 WHERE org_id = $2 AND digest = $3`, [
      bytes.byteLength + 1,
      ORG_A,
      ref.digest,
    ]);

    await expect(
      store.put({ orgId: ORG_A, bytes, mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE }),
    ).rejects.toMatchObject({ name: "CasArtifactIntegrityError" });
  });

  it("same-org positive + cross-org denial keeps zero cross-org effects", async () => {
    const store = new PgCasByteStore(runtimePool);
    const bytes = uniqueBytes("same-org");
    const ref = await store.put({
      orgId: ORG_A,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });
    // Same-org positive.
    expect(await store.has(ORG_A, ref.digest)).toBe(true);
    // Cross-org denial: org B cannot see org A's artifact.
    expect(await store.has(ORG_B, ref.digest)).toBe(false);
    await expect(store.get(ORG_B, ref.digest)).rejects.toMatchObject({
      name: "CasArtifactNotFoundError",
    });
    // Unscoped runtime SELECT sees zero rows (deny-by-default).
    const denied = await runtimePool.query("SELECT digest FROM cas_artifacts");
    expect(denied.rowCount).toBe(0);
  });
});

// ---- R2 follow-up: verifyStoredCasRow centralized-verifier unit coverage ----
// Pure-logic coverage for the centralized stored-row verifier shared by PgCas
// `get` + post-put read-back. This describe is intentionally OUTSIDE `describeDb`
// (not DB-gated) so the canonical-form / nonnegative / safe-integer / exact-length
// logic always runs — Postgres normalizes bigint text on storage, so the hostile
// row shapes below (leading zero, negative, non-integer, unsafe range) cannot be
// produced by a live UPDATE and are proved here against the verifier directly.
// The live corruption proofs for the get and put-conflict behavior paths live in
// the `describeDb` block above (inline_bytes + byte_size mismatch on both paths).
const VERIFY_ORG = "org_unit";
const VERIFY_PAYLOAD = new TextEncoder().encode("in2-r2-unit-payload");

function verifyRow(overrides: Partial<{ inline_bytes: Buffer | null; byte_size: string | number }> = {}): {
  inline_bytes: Buffer | null;
  byte_size: string | number;
} {
  return {
    inline_bytes: Buffer.from(VERIFY_PAYLOAD),
    byte_size: String(VERIFY_PAYLOAD.byteLength),
    ...overrides,
  };
}

describe("verifyStoredCasRow (in-2 R2 centralized CAS row verifier, no DB)", () => {
  it("returns the verified actual bytes + byte length for a consistent row", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    const verified = verifyStoredCasRow(VERIFY_ORG, digest, verifyRow());
    expect(verified.byteSize).toBe(VERIFY_PAYLOAD.byteLength);
    expect(Buffer.from(verified.bytes).equals(Buffer.from(VERIFY_PAYLOAD))).toBe(true);
  });

  it("accepts a numeric byte_size from drivers that return numbers", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    const verified = verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: VERIFY_PAYLOAD.byteLength }));
    expect(verified.byteSize).toBe(VERIFY_PAYLOAD.byteLength);
  });

  it("throws CasArtifactIntegrityError when inline bytes are missing", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    expect(() => verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ inline_bytes: null }))).toThrow(
      CasArtifactIntegrityError,
    );
  });

  it("throws CasArtifactIntegrityError when stored bytes do not hash to the requested digest", () => {
    const digest = contentDigestOf(new TextEncoder().encode("different-bytes"));
    expect(() => verifyStoredCasRow(VERIFY_ORG, digest, verifyRow())).toThrow(CasArtifactIntegrityError);
  });

  it("throws CasArtifactIntegrityError for a non-canonical byte_size (leading zero)", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    expect(() =>
      verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: `0${VERIFY_PAYLOAD.byteLength}` })),
    ).toThrow(CasArtifactIntegrityError);
  });

  it("throws CasArtifactIntegrityError for a negative byte_size", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    expect(() => verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: "-1" }))).toThrow(
      CasArtifactIntegrityError,
    );
  });

  it("throws CasArtifactIntegrityError for a non-integer byte_size", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    expect(() => verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: "1.5" }))).toThrow(
      CasArtifactIntegrityError,
    );
  });

  it("throws CasArtifactIntegrityError when byte_size exceeds the safe integer range", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    // 2^53 = exactly past Number.MAX_SAFE_INTEGER; canonical form but unsafe.
    expect(() => verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: "9007199254740992" }))).toThrow(
      CasArtifactIntegrityError,
    );
  });

  it("throws CasArtifactIntegrityError when byte_size does not equal actual bytes length", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    expect(() =>
      verifyStoredCasRow(VERIFY_ORG, digest, verifyRow({ byte_size: VERIFY_PAYLOAD.byteLength + 1 })),
    ).toThrow(CasArtifactIntegrityError);
  });

  it("throws CasArtifactIntegrityError (never a generic Error) on every failure shape", () => {
    const digest = contentDigestOf(VERIFY_PAYLOAD);
    const cases = [
      verifyRow({ inline_bytes: null }),
      verifyRow({ byte_size: "-1" }),
      verifyRow({ byte_size: "9007199254740992" }),
      verifyRow({ byte_size: VERIFY_PAYLOAD.byteLength + 1 }),
    ];
    for (const bad of cases) {
      expect(() => verifyStoredCasRow(VERIFY_ORG, digest, bad)).toThrow(CasArtifactIntegrityError);
    }
  });
});
