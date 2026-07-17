/**
 * in-2: minimal production CasByteStore adapter over SP-3 `cas_artifacts`
 * (migration 0035). Sole byte store — no second proof table, no parallel Digest.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { CasArtifactBytes, CasArtifactRef, CasByteStore, Digest } from "../contracts/cas.js";
import { CasArtifactIntegrityError, CasArtifactNotFoundError, contentDigestOf, parseDigest } from "../contracts/cas.js";

/**
 * Regex for a canonical nonnegative integer string: "0" or a digit string with
 * no leading zero, sign, decimal point, or exponent. pg hands bigint back as a
 * string; a corrupt/hostile row could carry a non-canonical form that a lossy
 * `Number(...)` would silently normalize, so the textual form is validated FIRST.
 */
const CANONICAL_NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/u;

/** Shape of a stored cas_artifacts row as selected by this adapter. */
interface StoredCasRow {
  readonly inline_bytes: Buffer | null;
  readonly byte_size: string | number;
}

/**
 * Verifies a stored cas_artifacts row is internally consistent and matches the
 * requested digest + actual inline bytes. Centralized so the `get` path and the
 * post-put read-back share ONE integrity check — a corrupt/mismatched row can
 * never produce a false success on either path. Exported so the canonical-form /
 * safe-integer / exact-length logic is unit-tested without a live Postgres.
 *
 * Checks (any failure → typed `CasArtifactIntegrityError`):
 * - inline bytes exist;
 * - the shared `contentDigestOf` helper hashes them to the requested digest;
 * - stored `byte_size` is a canonical, nonnegative, safely-representable integer;
 * - stored `byte_size` equals the ACTUAL inline bytes length exactly.
 *
 * `byte_size` is a bigint column; canonical bytes are always small, but a corrupt
 * or hostile value is validated as text and checked against the safe-integer
 * range BEFORE any numeric coercion — never a lossy `Number(bigint-string)` that
 * could round a huge value into equality. Returns the verified ACTUAL byte length
 * (derived from the bytes, never caller-echoed metadata).
 */
export function verifyStoredCasRow(
  orgId: string,
  digest: Digest,
  row: StoredCasRow,
): { readonly bytes: Uint8Array; readonly byteSize: number } {
  if (row.inline_bytes === null) {
    throw new CasArtifactIntegrityError(orgId, digest, "stored row has no inline bytes");
  }
  const bytes = new Uint8Array(row.inline_bytes);
  const storedDigest = contentDigestOf(bytes);
  if (storedDigest !== digest) {
    throw new CasArtifactIntegrityError(orgId, digest, "stored bytes do not hash to requested digest");
  }
  const rawSize = typeof row.byte_size === "number" ? String(row.byte_size) : row.byte_size;
  if (!CANONICAL_NONNEGATIVE_INTEGER.test(rawSize)) {
    throw new CasArtifactIntegrityError(
      orgId,
      digest,
      `stored byte_size is not a canonical nonnegative integer: ${rawSize}`,
    );
  }
  const storedSize = Number(rawSize);
  if (!Number.isSafeInteger(storedSize)) {
    throw new CasArtifactIntegrityError(orgId, digest, `stored byte_size exceeds the safe integer range: ${rawSize}`);
  }
  if (storedSize !== bytes.byteLength) {
    throw new CasArtifactIntegrityError(
      orgId,
      digest,
      `stored byte_size ${storedSize} does not equal actual inline bytes length ${bytes.byteLength}`,
    );
  }
  return { bytes, byteSize: storedSize };
}

export class PgCasByteStore implements CasByteStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async put(input: {
    readonly orgId: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await client.query(
        `INSERT INTO cas_artifacts (
           org_id, digest, byte_size, media_type, storage_backend,
           storage_key, inline_bytes, provider_checksum, encryption_state, retention_class
         ) VALUES (
           $1, $2, $3, $4, 'inline_pg',
           NULL, $5, NULL, 'none', 'standard'
         )
         ON CONFLICT (org_id, digest) DO UPDATE SET
           byte_size = EXCLUDED.byte_size,
           media_type = EXCLUDED.media_type,
           storage_backend = EXCLUDED.storage_backend,
           storage_key = EXCLUDED.storage_key,
           inline_bytes = EXCLUDED.inline_bytes,
           provider_checksum = COALESCE(EXCLUDED.provider_checksum, cas_artifacts.provider_checksum)
         WHERE cas_artifacts.storage_backend = 'object_store'
           AND cas_artifacts.media_type = 'application/vnd.tanren.provider-artifact-reference+json'`,
        [input.orgId, digest, input.bytes.byteLength, input.mediaType, Buffer.from(input.bytes)],
      );
    });
    // R2: return the STORED winner's metadata, never echo caller metadata. After
    // insert-or-conflict the row may have been written by an earlier caller with
    // a different mediaType (same bytes hash → same digest). Re-read + verify so
    // a collision/miswrite can never produce a false success.
    const stored = await this.readStored(input.orgId, digest);
    return { digest, byteSize: stored.byteSize, mediaType: stored.mediaType };
  }

  public async get(orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = await runWithOrgScope(this.pool, orgId, async (client) => {
      const result = await client.query<{
        digest: string;
        media_type: string;
        inline_bytes: Buffer | null;
        byte_size: string | number;
      }>(
        `SELECT digest, media_type, inline_bytes, byte_size
           FROM cas_artifacts
          WHERE org_id = $1 AND digest = $2`,
        [orgId, digest],
      );
      return result.rows[0];
    });
    if (row === undefined) {
      throw new CasArtifactNotFoundError(orgId, digest);
    }
    // R2: defense-in-depth on read. Trust nothing — verify the stored row's bytes
    // hash to the requested digest AND its byte_size is a canonical, safe, exact
    // match. Corruption/miswrite is a typed integrity error, never a false success.
    const verified = verifyStoredCasRow(orgId, digest, row);
    return {
      digest: parseDigest(row.digest),
      bytes: verified.bytes,
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
   * Re-reads the stored row for a digest and verifies its inline_bytes + byte_size.
   * Returns the STORED byte_size + mediaType (the winning writer's metadata), so
   * callers never receive a misleading echo of their own input. Shares the same
   * `verifyStoredCasRow` check as `get`, so a corrupt row fails identically on
   * both paths. The returned byteSize is the verified ACTUAL length, never a
   * lossy `Number(bigint-string)` conversion of caller-echoed metadata.
   */
  private async readStored(
    orgId: string,
    digest: Digest,
  ): Promise<{ readonly byteSize: number; readonly mediaType: string }> {
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
    if (row === undefined) {
      throw new CasArtifactIntegrityError(orgId, digest, "stored row missing immediately after put");
    }
    const verified = verifyStoredCasRow(orgId, digest, row);
    return { byteSize: verified.byteSize, mediaType: row.media_type };
  }
}
