/**
 * in-2: minimal production CasByteStore adapter over SP-3 `cas_artifacts`
 * (migration 0035). Sole byte store — no second proof table, no parallel Digest.
 */

import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { CasArtifactBytes, CasArtifactRef, CasByteStore, Digest } from "../contracts/cas.js";
import { CasArtifactIntegrityError, CasArtifactNotFoundError, parseDigest } from "../contracts/cas.js";

function digestOf(bytes: Uint8Array): Digest {
  const hex = createHash("sha256").update(bytes).digest("hex");
  return parseDigest(`sha256:${hex}`);
}

export class PgCasByteStore implements CasByteStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async put(input: {
    readonly orgId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<CasArtifactRef> {
    const digest = digestOf(input.bytes);
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await client.query(
        `INSERT INTO cas_artifacts (
           org_id, digest, byte_size, media_type, storage_backend,
           storage_key, inline_bytes, provider_checksum, encryption_state, retention_class
         ) VALUES (
           $1, $2, $3, $4, 'inline_pg',
           NULL, $5, NULL, 'none', 'standard'
         )
         ON CONFLICT (org_id, digest) DO NOTHING`,
        [input.orgId, digest, input.bytes.byteLength, input.mediaType, Buffer.from(input.bytes)],
      );
    });
    // R2: return the STORED winner's metadata, never echo caller metadata. After
    // insert-or-conflict the row may have been written by an earlier caller with
    // a different mediaType (same bytes hash → same digest). Re-read + re-hash so
    // a collision/miswrite can never produce a false success.
    return this.readStored(input.orgId, digest);
  }

  public async get(orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        digest: string;
        media_type: string;
        inline_bytes: Buffer | null;
      }>(
        `SELECT digest, media_type, inline_bytes
           FROM cas_artifacts
          WHERE org_id = $1 AND digest = $2`,
        [orgId, digest],
      );
      return result.rows[0];
    });
    if (row === undefined || row.inline_bytes === null) {
      throw new CasArtifactNotFoundError(orgId, digest);
    }
    const bytes = new Uint8Array(row.inline_bytes);
    // R2: defense-in-depth on read. Trust nothing — verify stored bytes hash to
    // the requested digest; corruption is a typed integrity error, never silent.
    const storedDigest = digestOf(bytes);
    if (storedDigest !== digest) {
      throw new CasArtifactIntegrityError(orgId, digest, "stored bytes do not hash to requested digest");
    }
    return {
      digest: parseDigest(row.digest),
      bytes,
      mediaType: row.media_type,
    };
  }

  public async has(orgId: string, digest: Digest): Promise<boolean> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{ ok: number }>(
        `SELECT 1 AS ok FROM cas_artifacts WHERE org_id = $1 AND digest = $2`,
        [orgId, digest],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Re-reads the stored row for a digest and verifies its inline_bytes hash to
   * the digest. Returns the STORED byte_size + mediaType (the winning writer's
   * metadata), so callers never receive a misleading echo of their own input.
   * `byte_size` is a bigint column (pg returns it as a string); canonical bytes
   * are always small, so `Number(...)` is safe and keeps the contract numeric.
   */
  private async readStored(orgId: string, digest: Digest): Promise<CasArtifactRef> {
    const row = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        byte_size: string | number;
        media_type: string;
        inline_bytes: Buffer | null;
      }>(
        `SELECT byte_size, media_type, inline_bytes
           FROM cas_artifacts
          WHERE org_id = $1 AND digest = $2`,
        [orgId, digest],
      );
      return result.rows[0];
    });
    if (row === undefined || row.inline_bytes === null) {
      throw new CasArtifactIntegrityError(orgId, digest, "stored row missing immediately after put");
    }
    const storedDigest = digestOf(new Uint8Array(row.inline_bytes));
    if (storedDigest !== digest) {
      throw new CasArtifactIntegrityError(orgId, digest, "stored bytes do not hash to requested digest");
    }
    return { digest, byteSize: Number(row.byte_size), mediaType: row.media_type };
  }
}
