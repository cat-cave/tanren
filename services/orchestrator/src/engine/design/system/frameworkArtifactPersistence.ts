// ds-7 — generic framework artifact persistence. Mirrors `persistWebDesignArtifact`
// but is TARGET-AGNOSTIC: any framework adapter's projection (manifest + files)
// persists through the SAME CAS + `design_artifacts` + `design_artifact_files`
// path web uses, so a Bevy/SwiftUI/Compose/Flutter/RN/generic-web/document
// artifact lands on the org-scoped tables behind the same fail-closed guards
// (CAS digest verified, exact-file-set post-condition). The receipt's
// `artifactDigest` MUST be the manifest digest persisted here — proof≡effect.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { artifactObjectStoreKey, sha256Digest, type ArtifactStore } from "./artifactStore.js";
import { DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE } from "./designArtifactSchemas.js";
import type { FrameworkArtifactFile } from "./frameworkAdapterCore.js";
import type { DesignAdapterConformanceTarget } from "./adapterConformanceReceipt.js";

/** Thrown when a framework artifact's persistence guards fail. */
export class FrameworkArtifactPersistenceError extends Error {
  constructor(readonly issue: string) {
    super(`framework design artifact persistence failed: ${issue}`);
    this.name = "FrameworkArtifactPersistenceError";
  }
}

export interface FrameworkArtifactPublishContext {
  readonly pool: pg.Pool;
  readonly artifactStore: ArtifactStore;
  readonly orgId: string;
  readonly projectId: string;
  readonly designSystemId: string;
}

export interface FrameworkArtifactBuildResult {
  /** The artifact id (caller-assigned, stable per target+release). */
  readonly artifactId: string;
  /** The release id this artifact belongs to. */
  readonly releaseId: string;
  /** The target key this projection ships. */
  readonly target: DesignAdapterConformanceTarget;
  /** The contract digest the artifact binds. */
  readonly contractDigest: string;
  /** The plain-release digest (the bootstrapped plain base). */
  readonly plainReleaseDigest: string;
  /** The polished-release digest (the curated composition). */
  readonly polishedReleaseDigest: string;
  /** The materialized file set (descriptor + bytes). */
  readonly files: readonly FrameworkArtifactFile[];
  /** The exported projection ids. */
  readonly exports: readonly string[];
  /** The fragment lineage persisted into this artifact. */
  readonly fragmentLineage: readonly string[];
}

export interface PersistedFrameworkArtifact {
  readonly artifactId: string;
  readonly artifactDigest: string;
}

/**
 * Put every byte first, then atomically record the immutable artifact metadata +
 * file index under the org's RLS scope. CAS orphans are reusable after a DB
 * failure; a table row can NEVER point at an unverified byte address. Mirrors
 * `persistWebDesignArtifact` exactly in shape — the table is target-agnostic.
 *
 * Returns the manifest digest so the caller can bind a conformance receipt to
 * the EXACT artifact coordinate (proof≡effect, trap #7).
 */
export async function persistFrameworkDesignArtifact(
  input: FrameworkArtifactPublishContext & {
    readonly artifact: FrameworkArtifactBuildResult;
    readonly manifestBytes: Uint8Array;
  },
): Promise<PersistedFrameworkArtifact> {
  const artifactDigest = await putVerified(input.artifactStore, input.manifestBytes, input.artifact.artifactId);
  for (const file of input.artifact.files) {
    const storedDigest = await putVerified(input.artifactStore, file.bytes, file.path);
    if (storedDigest !== file.digest) {
      throw new FrameworkArtifactPersistenceError(`CAS digest for '${file.path}' does not match generated descriptor`);
    }
  }
  await runWithOrgScope(input.pool, input.orgId, async (client) => {
    await client.query(
      `INSERT INTO design_artifacts
         (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        input.orgId,
        input.artifact.artifactId,
        input.designSystemId,
        artifactDigest,
        DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE,
        artifactObjectStoreKey(artifactDigest),
        input.manifestBytes.byteLength,
      ],
    );
    const stored = await client.query<StoredArtifactRow>(
      `SELECT design_system_id, digest, media_type, object_store_key, byte_size
         FROM design_artifacts WHERE org_id = $1 AND id = $2`,
      [input.orgId, input.artifact.artifactId],
    );
    const row = stored.rows[0];
    if (row === undefined) {
      throw new FrameworkArtifactPersistenceError("artifact row was not readable after insert");
    }
    if (
      row.design_system_id !== input.designSystemId ||
      row.digest !== artifactDigest ||
      row.media_type !== DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE ||
      row.object_store_key !== artifactObjectStoreKey(artifactDigest) ||
      byteSize(row.byte_size) !== input.manifestBytes.byteLength
    ) {
      throw new FrameworkArtifactPersistenceError(
        `artifact id '${input.artifact.artifactId}' conflicts with different immutable metadata`,
      );
    }
    for (const file of input.artifact.files) {
      await client.query(
        `INSERT INTO design_artifact_files
           (org_id, artifact_id, path, kind, media_type, digest, byte_size, executable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, artifact_id, path) DO NOTHING`,
        [
          input.orgId,
          input.artifact.artifactId,
          file.path,
          file.kind,
          file.mediaType,
          file.digest,
          file.byteSize,
          file.executable,
        ],
      );
    }
    const files = await client.query<StoredFileRow>(
      `SELECT path, kind, media_type, digest, byte_size, executable
         FROM design_artifact_files WHERE org_id = $1 AND artifact_id = $2`,
      [input.orgId, input.artifact.artifactId],
    );
    if (files.rows.length !== input.artifact.files.length) {
      throw new FrameworkArtifactPersistenceError(
        "stored framework artifact file set does not exactly match the generated manifest",
      );
    }
    const storedByPath = new Map(files.rows.map((fileRow) => [fileRow.path, fileRow]));
    for (const file of input.artifact.files) {
      const fileRow = storedByPath.get(file.path);
      if (
        fileRow === undefined ||
        fileRow.kind !== file.kind ||
        fileRow.media_type !== file.mediaType ||
        fileRow.digest !== file.digest ||
        fileRow.executable !== file.executable ||
        byteSize(fileRow.byte_size) !== file.byteSize
      ) {
        throw new FrameworkArtifactPersistenceError(`file '${file.path}' conflicts with different immutable metadata`);
      }
    }
  });
  return { artifactId: input.artifact.artifactId, artifactDigest };
}

async function putVerified(store: ArtifactStore, bytes: Uint8Array, label: string): Promise<string> {
  const digest = await store.put(bytes);
  const expected = sha256Digest(bytes);
  if (digest !== expected) {
    throw new FrameworkArtifactPersistenceError(
      `ArtifactStore returned '${digest}' for '${label}', expected '${expected}'`,
    );
  }
  return digest;
}

interface StoredArtifactRow {
  readonly design_system_id: string | null;
  readonly digest: string;
  readonly media_type: string;
  readonly object_store_key: string;
  readonly byte_size: string | number;
}

interface StoredFileRow {
  readonly path: string;
  readonly kind: string;
  readonly media_type: string;
  readonly digest: string;
  readonly byte_size: string | number;
  readonly executable: boolean;
}

function byteSize(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FrameworkArtifactPersistenceError(`invalid stored byte_size '${value}'`);
  }
  return parsed;
}
