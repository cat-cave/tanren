// ds-7 — target-agnostic artifact persistence over a fake CAS + query client.
// This pins proof≡effect and the immutable file-set postcondition without a DB.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { artifactObjectStoreKey, sha256Digest, type ArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE } from "../src/engine/design/system/designArtifactSchemas.js";
import {
  FrameworkArtifactPersistenceError,
  persistFrameworkDesignArtifact,
  type FrameworkArtifactBuildResult,
} from "../src/engine/design/system/frameworkArtifactPersistence.js";

const DIGEST = `sha256:${"f".repeat(64)}`;
const text = new TextEncoder();

function buildArtifact(): FrameworkArtifactBuildResult {
  const bytes = text.encode('pub const PRIMARY: &str = \\"#155eef\\";\\n');
  return {
    artifactId: "artifact_ds7",
    releaseId: "release_ds7",
    target: "bevy",
    contractDigest: DIGEST,
    plainReleaseDigest: DIGEST,
    polishedReleaseDigest: DIGEST,
    files: [
      {
        path: "src/tokens.rs",
        kind: "tokens",
        mediaType: "text/plain",
        digest: sha256Digest(bytes),
        byteSize: bytes.byteLength,
        executable: false,
        bytes,
      },
    ],
    exports: [],
    fragmentLineage: [],
  };
}

function memoryStore(): ArtifactStore {
  return {
    put: async (bytes) => sha256Digest(bytes),
    get: async () => new Uint8Array(),
  };
}

function persistencePool(
  artifact: FrameworkArtifactBuildResult,
  manifestBytes: Uint8Array,
  options: {
    readonly artifactRow?: Record<string, unknown>;
    readonly fileRows?: readonly Record<string, unknown>[];
  } = {},
) {
  const manifestDigest = sha256Digest(manifestBytes);
  const query = vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(async (sql: string) => {
    if (sql.includes("SELECT design_system_id, digest, media_type")) {
      return {
        rows: [
          {
            design_system_id: "design_ds7",
            digest: manifestDigest,
            media_type: DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE,
            object_store_key: artifactObjectStoreKey(manifestDigest),
            byte_size: String(manifestBytes.byteLength),
            ...options.artifactRow,
          },
        ],
      };
    }
    if (sql.includes("SELECT path, kind, media_type, digest, byte_size, executable")) {
      return {
        rows:
          options.fileRows ??
          artifact.files.map((file) => ({
            path: file.path,
            kind: file.kind,
            media_type: file.mediaType,
            digest: file.digest,
            byte_size: String(file.byteSize),
            executable: file.executable,
          })),
      };
    }
    return { rows: [] };
  });
  return {
    pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    query,
    manifestDigest,
  };
}

describe("persistFrameworkDesignArtifact — DB-free proof/effect binding", () => {
  it("persists the verified manifest plus its exact immutable file index", async () => {
    const artifact = buildArtifact();
    const manifestBytes = text.encode('{"manifestVersion":1}\\n');
    const { pool, query, manifestDigest } = persistencePool(artifact, manifestBytes);

    await expect(
      persistFrameworkDesignArtifact({
        pool,
        artifactStore: memoryStore(),
        orgId: "org_ds7",
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        artifact,
        manifestBytes,
      }),
    ).resolves.toEqual({ artifactId: artifact.artifactId, artifactDigest: manifestDigest });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO design_artifacts"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO design_artifact_files"))).toBe(true);
  });

  it("rejects a CAS that returns a digest other than the bytes it accepted", async () => {
    const artifact = buildArtifact();
    const manifestBytes = text.encode('{"manifestVersion":1}\\n');
    const { pool } = persistencePool(artifact, manifestBytes);
    const lyingStore: ArtifactStore = {
      put: async () => DIGEST,
      get: async () => new Uint8Array(),
    };

    await expect(
      persistFrameworkDesignArtifact({
        pool,
        artifactStore: lyingStore,
        orgId: "org_ds7",
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        artifact,
        manifestBytes,
      }),
    ).rejects.toBeInstanceOf(FrameworkArtifactPersistenceError);
  });

  it("rejects a persisted artifact row whose immutable metadata differs from the manifest", async () => {
    const artifact = buildArtifact();
    const manifestBytes = text.encode('{"manifestVersion":1}\\n');
    const { pool } = persistencePool(artifact, manifestBytes, { artifactRow: { design_system_id: "forged_design" } });

    await expect(
      persistFrameworkDesignArtifact({
        pool,
        artifactStore: memoryStore(),
        orgId: "org_ds7",
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        artifact,
        manifestBytes,
      }),
    ).rejects.toThrow(/conflicts with different immutable metadata/u);
  });

  it("rejects a persisted file index that is not the exact generated file set", async () => {
    const artifact = buildArtifact();
    const manifestBytes = text.encode('{"manifestVersion":1}\\n');
    const { pool } = persistencePool(artifact, manifestBytes, { fileRows: [] });

    await expect(
      persistFrameworkDesignArtifact({
        pool,
        artifactStore: memoryStore(),
        orgId: "org_ds7",
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        artifact,
        manifestBytes,
      }),
    ).rejects.toThrow(/file set does not exactly match/u);
  });
});
