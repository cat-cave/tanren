// ds-8 DB-free negative controls: no bearer spill, no grant/fork on a bad share,
// and no success event for a quarantined/lossy external snapshot.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  DesignEcosystemService,
  type DesignEcosystemError,
} from "../src/engine/design/system/designEcosystemService.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const TOKEN = "share-token-which-is-long-enough-to-be-accepted";

function fakePool(
  options: {
    readonly publicRow?: Record<string, unknown>;
    readonly redemption?: boolean;
    readonly sourceOwned?: boolean;
  } = {},
) {
  const external = new Map<string, { receipt: unknown; receiptDigest: string }>();
  const query = vi.fn<
    (sql: string, values?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  >(async (sql, values = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM published_design_system_releases")) {
      return options.publicRow === undefined ? { rows: [], rowCount: 0 } : { rows: [options.publicRow], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM design_system_releases")) {
      return options.sourceOwned === true ? { rows: [{ id: "release_a" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM design_system_grants WHERE")) return { rows: [], rowCount: 0 };
    if (sql.includes("UPDATE design_share_links")) {
      return options.redemption === true
        ? { rows: [{ permission: "fork", publication_id: "pub_a", source_release_digest: DIGEST }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE published_design_system_releases")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO design_system_grants")) {
      return {
        rows: [{ id: "grant_a", publication_id: "pub_a", allowed_release_digest: DIGEST, capability: "fork" }],
        rowCount: 1,
      };
    }
    if (sql.includes("INSERT INTO design_external_imports")) {
      external.set(String(values[1]), { receipt: JSON.parse(String(values[7])), receiptDigest: String(values[6]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT receipt, receipt_digest FROM design_external_imports")) {
      const row = external.get(String(values[1]));
      return row === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ receipt: row.receipt, receipt_digest: row.receiptDigest }], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, query };
}

describe("DesignEcosystemService fail-closed controls", () => {
  it("returns only the sanitized public projection for a guessed publication id", async () => {
    const { pool, query } = fakePool({
      publicRow: {
        publication_id: "pub_a",
        public_slug: "console",
        source_release_digest: DIGEST,
        manifest_digest: DIGEST,
        safe_preview_digest: DIGEST,
        license: "MIT",
        attribution: { notice: "example" },
        state: "published",
      },
    });
    const result = await new DesignEcosystemService(pool).readPublic("pub_a");
    expect(result).toEqual(expect.objectContaining({ publicationId: "pub_a", manifestDigest: DIGEST }));
    expect(JSON.stringify(result)).not.toMatch(/artifactId|objectStore|orgId|download/iu);
    expect(query.mock.calls.some(([sql]) => sql.includes("state = 'published' AND revoked_at IS NULL"))).toBe(true);
  });

  it("rejects an expired/revoked or guessed bearer before any grant insert", async () => {
    const { pool, query } = fakePool();
    const service = new DesignEcosystemService(pool);
    await expect(
      service.execute({
        orgId: "org_b",
        actorId: "admin_b",
        idempotencyKey: "redeem-1",
        command: {
          type: "redeem_share",
          grantId: "grant_b",
          publicationId: "pub_a",
          releaseDigest: DIGEST,
          bearerToken: TOKEN,
          grantExpiresAt: "2030-01-01T00:00:00.000Z",
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DesignEcosystemError>);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO design_system_grants"))).toBe(false);
    const redemptionSql = query.mock.calls.find(([sql]) => sql.includes("UPDATE design_share_links"))?.[0] ?? "";
    expect(redemptionSql).toContain("share.revoked_at IS NULL");
    expect(redemptionSql).toContain("share.expires_at > now()");
    expect(redemptionSql).toContain("share.redemption_count < share.redemption_limit");
    expect(redemptionSql).toContain("publication.state = 'published'");
  });

  it("rejects a source-release id guessed by another organization before creating a share", async () => {
    const { pool, query } = fakePool({
      publicRow: {
        publication_id: "pub_a",
        public_slug: "console",
        source_release_digest: DIGEST,
        manifest_digest: DIGEST,
        safe_preview_digest: DIGEST,
        license: "MIT",
        attribution: { notice: "example" },
        state: "published",
      },
    });
    await expect(
      new DesignEcosystemService(pool).execute({
        orgId: "org_b",
        actorId: "admin_b",
        idempotencyKey: "share-foreign-source",
        command: {
          type: "create_share",
          shareId: "share_b",
          publicationId: "pub_a",
          sourceReleaseId: "release_a",
          releaseDigest: DIGEST,
          recipientOrgId: "org_c",
          bearerToken: TOKEN,
          permission: "fork",
          expiresAt: "2030-01-01T00:00:00.000Z",
          redemptionLimit: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DesignEcosystemError>);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO design_share_links"))).toBe(false);
  });

  it("fails closed when a foreign organization tries to revoke a publication", async () => {
    const { pool, query } = fakePool();
    await expect(
      new DesignEcosystemService(pool).execute({
        orgId: "org_b",
        actorId: "admin_b",
        idempotencyKey: "foreign-revoke",
        command: { type: "revoke_publication", publicationId: "pub_a" },
      }),
    ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DesignEcosystemError>);
    const call = query.mock.calls.find(([sql]) => sql.includes("UPDATE published_design_system_releases"));
    expect(call?.[0]).toContain("source_org_id = $2");
    expect(call?.[1]).toEqual(["pub_a", "org_b"]);
  });

  it("records a lossy Figma snapshot as rejected and emits no candidate/fork success event", async () => {
    const { pool, query } = fakePool();
    const result = await new DesignEcosystemService(pool).execute({
      orgId: "org_b",
      actorId: "admin_b",
      idempotencyKey: "figma-1",
      command: {
        type: "pull_figma",
        externalImportId: "external_b",
        locator: "figma://file/abc",
        externalRevision: "rev-7",
        snapshotDigest: DIGEST,
        licenseVerdict: "approved",
        lossinessReport: { lossless: false, warnings: ["gradient flattened"] },
      },
    });
    expect(result).toMatchObject({ kind: "external_import_recorded", receipt: { disposition: "rejected" } });
    expect(query.mock.calls.some(([sql]) => sql.includes("design_system_releases"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("events"))).toBe(false);
  });

  it("rejects a blank bearer at the strict command gate before any query", async () => {
    const { pool, query } = fakePool();
    await expect(
      new DesignEcosystemService(pool).execute({
        orgId: "org_b",
        actorId: "admin_b",
        idempotencyKey: "bad-token",
        command: {
          type: "redeem_share",
          grantId: "grant_b",
          publicationId: "pub_a",
          releaseDigest: DIGEST,
          bearerToken: "   ",
          grantExpiresAt: "2030-01-01T00:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/required|too small/iu);
    expect(query).not.toHaveBeenCalled();
  });
});
