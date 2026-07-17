// ds-2 — org-scoped persistence of a generated web artifact through ds-1 CAS.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { artifactObjectStoreKey, sha256Digest, type ArtifactStore } from "./artifactStore.js";
import { DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE } from "./designArtifactSchemas.js";
import type { EventStore } from "../../eventStore.js";
import type { WebArtifactBuildResult } from "./webAdapter.js";

export class WebArtifactPersistenceError extends Error {
  constructor(readonly issue: string) {
    super(`web design artifact persistence failed: ${issue}`);
    this.name = "WebArtifactPersistenceError";
  }
}

export interface WebArtifactPublishContext {
  readonly pool: pg.Pool;
  readonly artifactStore: ArtifactStore;
  readonly eventStore?: EventStore;
  readonly orgId: string;
  readonly projectId: string;
}

export interface PersistWebArtifactInput extends WebArtifactPublishContext {
  readonly designSystemId: string;
  readonly artifact: WebArtifactBuildResult;
}

export interface PersistedWebArtifact {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly catalogDigest: string;
}

/**
 * Put every byte first, then atomically record its immutable metadata and file
 * index under the org's RLS scope. CAS orphans are harmless/reusable after a DB
 * failure; a table row can never point at an unverified byte address.
 */
export async function persistWebDesignArtifact(input: PersistWebArtifactInput): Promise<PersistedWebArtifact> {
  const artifactDigest = await putVerified(input.artifactStore, input.artifact.manifestBytes);
  for (const file of input.artifact.files) {
    const storedDigest = await putVerified(input.artifactStore, file.bytes);
    if (storedDigest !== file.digest) {
      throw new WebArtifactPersistenceError(`CAS digest for '${file.path}' does not match generated descriptor`);
    }
  }
  await runWithOrgScope(input.pool, input.orgId, async (client) => {
    await client.query(
      `INSERT INTO design_artifacts
         (org_id, id, design_system_id, digest, media_type, manifest_version, object_store_key, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        input.orgId,
        input.artifact.manifest.artifactId,
        input.designSystemId,
        artifactDigest,
        DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE,
        input.artifact.manifest.manifestVersion,
        artifactObjectStoreKey(artifactDigest),
        input.artifact.manifestBytes.byteLength,
      ],
    );
    const stored = await client.query<StoredArtifactRow>(
      `SELECT design_system_id, digest, media_type, manifest_version, object_store_key, byte_size
         FROM design_artifacts WHERE org_id = $1 AND id = $2`,
      [input.orgId, input.artifact.manifest.artifactId],
    );
    const row = stored.rows[0];
    if (row === undefined) throw new WebArtifactPersistenceError("artifact row was not readable after insert");
    assertStoredArtifact(row, input, artifactDigest);
    for (const file of input.artifact.files) {
      await client.query(
        `INSERT INTO design_artifact_files
           (org_id, artifact_id, path, kind, media_type, digest, byte_size, executable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (org_id, artifact_id, path) DO NOTHING`,
        [
          input.orgId,
          input.artifact.manifest.artifactId,
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
      [input.orgId, input.artifact.manifest.artifactId],
    );
    assertStoredFiles(files.rows, input);
  });
  const catalogDigest = catalogDigestOf(input.artifact);
  await emitPublishedEvents(input, artifactDigest, catalogDigest);
  return { artifactId: input.artifact.manifest.artifactId, artifactDigest, catalogDigest };
}

async function putVerified(store: ArtifactStore, bytes: Uint8Array): Promise<string> {
  const digest = await store.put(bytes);
  const expected = sha256Digest(bytes);
  if (digest !== expected)
    throw new WebArtifactPersistenceError(`ArtifactStore returned '${digest}', expected '${expected}'`);
  return digest;
}

interface StoredArtifactRow {
  readonly design_system_id: string | null;
  readonly digest: string;
  readonly media_type: string;
  readonly manifest_version: number;
  readonly object_store_key: string;
  readonly byte_size: string | number;
}

function assertStoredArtifact(row: StoredArtifactRow, input: PersistWebArtifactInput, digest: string): void {
  const manifest = input.artifact.manifest;
  const matches =
    row.design_system_id === input.designSystemId &&
    row.digest === digest &&
    row.media_type === DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE &&
    row.manifest_version === manifest.manifestVersion &&
    row.object_store_key === artifactObjectStoreKey(digest) &&
    byteSize(row.byte_size) === input.artifact.manifestBytes.byteLength;
  if (!matches)
    throw new WebArtifactPersistenceError(
      `artifact id '${manifest.artifactId}' conflicts with different immutable metadata`,
    );
}

interface StoredFileRow {
  readonly path: string;
  readonly kind: string;
  readonly media_type: string;
  readonly digest: string;
  readonly byte_size: string | number;
  readonly executable: boolean;
}

function assertStoredFiles(rows: readonly StoredFileRow[], input: PersistWebArtifactInput): void {
  if (rows.length !== input.artifact.files.length) {
    throw new WebArtifactPersistenceError("stored artifact file set does not exactly match the generated manifest");
  }
  const stored = new Map(rows.map((row) => [row.path, row]));
  for (const file of input.artifact.files) {
    const row = stored.get(file.path);
    if (
      row === undefined ||
      row.kind !== file.kind ||
      row.media_type !== file.mediaType ||
      row.digest !== file.digest ||
      row.executable !== file.executable ||
      byteSize(row.byte_size) !== file.byteSize
    ) {
      throw new WebArtifactPersistenceError(`file '${file.path}' conflicts with different immutable metadata`);
    }
  }
}

function byteSize(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new WebArtifactPersistenceError(`invalid stored byte_size '${value}'`);
  return parsed;
}

function catalogDigestOf(artifact: WebArtifactBuildResult): string {
  const catalog = artifact.files.find((file) => file.path === "catalog/components.json");
  if (catalog === undefined) throw new WebArtifactPersistenceError("generated artifact lacks catalog/components.json");
  return catalog.digest;
}

async function emitPublishedEvents(
  input: PersistWebArtifactInput,
  artifactDigest: string,
  catalogDigest: string,
): Promise<void> {
  if (input.eventStore === undefined) return;
  const { artifactId, releaseId } = input.artifact.manifest;
  await input.eventStore.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "design.catalog.built",
    payload: {
      projectId: input.projectId,
      catalogId: `${artifactId}:web-catalog`,
      catalogDigest,
      artifactIds: [artifactId],
    },
  });
  for (const output of input.artifact.exports) {
    const digest = input.artifact.files.find((file) => file.path === output.file.path)?.digest;
    if (digest === undefined)
      throw new WebArtifactPersistenceError(`generated export '${output.id}' is missing its artifact file`);
    await input.eventStore.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "design.export.produced",
      payload: { projectId: input.projectId, artifactId, exportId: output.id, format: output.id, outputDigest: digest },
    });
  }
  await input.eventStore.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "design.artifact.published",
    payload: { projectId: input.projectId, artifactId, releaseId, artifactDigest },
  });
}
