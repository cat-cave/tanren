/**
 * in-2: minimal production CasByteStore adapter over SP-3 `cas_artifacts`
 * (migration 0035). Sole byte store — no second proof table, no parallel Digest.
 */

import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { CasArtifactBytes, CasArtifactRef, CasByteStore, Digest } from "../contracts/cas.js";
import { CasArtifactNotFoundError, parseDigest } from "../contracts/cas.js";

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
    const byteSize = input.bytes.byteLength;
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
        [input.orgId, digest, byteSize, input.mediaType, Buffer.from(input.bytes)],
      );
    });
    return { digest, byteSize, mediaType: input.mediaType };
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
    return {
      digest: parseDigest(row.digest),
      bytes: new Uint8Array(row.inline_bytes),
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
}
