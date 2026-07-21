// DB-free coverage for the design-system release persistence seam. The router
// returns immutable rows exactly as Postgres would, proving each method maps or
// blocks state transitions without needing an actual pool.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AmbiguousProjectWebDesignSystemError,
  DesignSystemNotFoundError,
  DesignSystemReleaseStore,
  PersistedWebDesignWriterContextError,
  resolveProjectWebDesignSystem,
} from "../src/engine/design/system/designSystemStore.js";

const DIGEST = `sha256:${"1".repeat(64)}`;

function releaseRow(state: "draft" | "published", canonicalArtifactId: string | null) {
  return {
    id: "release_ds7",
    design_system_id: "design_ds7",
    version: 1,
    parent_release_id: null,
    state,
    contract_id: "contract_ds7",
    contract_version: 1,
    contract_digest: DIGEST,
    manifest_schema_version: 1,
    canonical_artifact_id: canonicalArtifactId,
    compatibility_summary: {},
  };
}

function releasePool(
  options: {
    readonly publishable?: boolean;
    readonly readable?: boolean;
    readonly createSystem?: boolean;
    readonly createRelease?: boolean;
  } = {},
) {
  const query = vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(async (sql: string) => {
    if (sql.includes("INSERT INTO design_systems")) {
      return {
        rows:
          options.createSystem === false
            ? []
            : [
                {
                  id: "design_ds7",
                  slug: "ds7",
                  name: "DS-7",
                  description: "",
                  lifecycle: "draft",
                  default_channel: "stable",
                },
              ],
      };
    }
    if (sql.includes("INSERT INTO design_system_releases"))
      return { rows: options.createRelease === false ? [] : [releaseRow("draft", null)] };
    if (sql.includes("UPDATE design_system_releases")) {
      return { rows: options.publishable === false ? [] : [releaseRow("published", "artifact_ds7")] };
    }
    if (sql.includes("WHERE org_id = $1 AND id = $2")) {
      return { rows: options.readable === false ? [] : [releaseRow("published", "artifact_ds7")] };
    }
    if (sql.includes("ORDER BY version DESC LIMIT 1")) return { rows: [releaseRow("published", "artifact_ds7")] };
    if (sql.includes("ORDER BY version DESC")) return { rows: [releaseRow("published", "artifact_ds7")] };
    return { rows: [] };
  });
  return { pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, query };
}

describe("DesignSystemReleaseStore — fake-pool immutable release state", () => {
  it("creates, publishes, and reads the same validated release through every read method", async () => {
    const { pool, query } = releasePool();
    const store = new DesignSystemReleaseStore(pool);

    await expect(
      store.createSystem({ orgId: "org_ds7", id: "design_ds7", slug: "ds7", name: "DS-7" }),
    ).resolves.toMatchObject({ id: "design_ds7", lifecycle: "draft" });
    await expect(
      store.createRelease({
        orgId: "org_ds7",
        id: "release_ds7",
        designSystemId: "design_ds7",
        version: 1,
        contractId: "contract_ds7",
        contractVersion: 1,
        contractDigest: DIGEST,
        manifestSchemaVersion: 1,
        createdBy: "operator",
      }),
    ).resolves.toMatchObject({ state: "draft" });
    await expect(
      store.publishRelease({
        orgId: "org_ds7",
        releaseId: "release_ds7",
        canonicalArtifactId: "artifact_ds7",
        publishedBy: "operator",
      }),
    ).resolves.toMatchObject({ state: "published", canonicalArtifactId: "artifact_ds7" });
    await expect(store.getRelease("org_ds7", "release_ds7")).resolves.toMatchObject({ releaseId: "release_ds7" });
    await expect(store.getLatestRelease("org_ds7", "design_ds7")).resolves.toMatchObject({ releaseId: "release_ds7" });
    await expect(store.listReleases("org_ds7", "design_ds7")).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalled();
  });

  it("fails closed when an immutable release cannot be transitioned to published", async () => {
    const { pool } = releasePool({ publishable: false });
    const store = new DesignSystemReleaseStore(pool);

    await expect(
      store.publishRelease({
        orgId: "org_ds7",
        releaseId: "release_ds7",
        canonicalArtifactId: "artifact_ds7",
        publishedBy: "operator",
      }),
    ).rejects.toBeInstanceOf(DesignSystemNotFoundError);
  });

  it("fails closed when a release is absent under the org-scoped read", async () => {
    const { pool } = releasePool({ readable: false });
    const store = new DesignSystemReleaseStore(pool);

    await expect(store.getRelease("org_ds7", "release_ds7")).rejects.toBeInstanceOf(DesignSystemNotFoundError);
  });

  it("fails closed when create operations do not read back their immutable rows", async () => {
    await expect(
      new DesignSystemReleaseStore(releasePool({ createSystem: false }).pool).createSystem({
        orgId: "org_ds7",
        id: "design_ds7",
        slug: "ds7",
        name: "DS-7",
      }),
    ).rejects.toBeInstanceOf(DesignSystemNotFoundError);
    await expect(
      new DesignSystemReleaseStore(releasePool({ createRelease: false }).pool).createRelease({
        orgId: "org_ds7",
        id: "release_ds7",
        designSystemId: "design_ds7",
        version: 1,
        contractId: "contract_ds7",
        contractVersion: 1,
        contractDigest: DIGEST,
        manifestSchemaVersion: 1,
        createdBy: "operator",
      }),
    ).rejects.toBeInstanceOf(DesignSystemNotFoundError);
  });

  it("resolves only one linkage whose frozen writer context matches the persisted identifiers", async () => {
    const row = {
      design_system_id: "design_ds7",
      release_id: "release_ds7",
      artifact_id: "artifact_ds7",
      source: 0,
      web_writer_context: {
        designSystemId: "design_ds7",
        releaseId: "release_ds7",
        artifactId: "artifact_ds7",
        catalog: { schemaVersion: 1, framework: "react", style: "shadcn", components: [] },
        tokens: [],
      },
    };
    const client = { query: async () => ({ rows: [row] }) } as never;

    await expect(
      resolveProjectWebDesignSystem(client, { orgId: "org_ds7", projectId: "project_ds7" }),
    ).resolves.toMatchObject({
      artifactId: "artifact_ds7",
    });
  });

  it("fails closed for ambiguous or identifier-mismatched persisted writer contexts", async () => {
    const validContext = {
      designSystemId: "design_ds7",
      releaseId: "release_ds7",
      artifactId: "artifact_ds7",
      catalog: { schemaVersion: 1, framework: "react", style: "shadcn", components: [] },
      tokens: [],
    };
    const ambiguous = {
      query: async () => ({
        rows: [
          {
            design_system_id: "design_ds7",
            release_id: "release_ds7",
            artifact_id: "artifact_ds7",
            source: 0,
            web_writer_context: validContext,
          },
          {
            design_system_id: "design_other",
            release_id: "release_other",
            artifact_id: "artifact_other",
            source: 0,
            web_writer_context: validContext,
          },
        ],
      }),
    } as never;
    const mismatched = {
      query: async () => ({
        rows: [
          {
            design_system_id: "design_ds7",
            release_id: "release_ds7",
            artifact_id: "artifact_forged",
            source: 0,
            web_writer_context: validContext,
          },
        ],
      }),
    } as never;

    await expect(
      resolveProjectWebDesignSystem(ambiguous, { orgId: "org_ds7", projectId: "project_ds7" }),
    ).rejects.toBeInstanceOf(AmbiguousProjectWebDesignSystemError);
    await expect(
      resolveProjectWebDesignSystem(mismatched, { orgId: "org_ds7", projectId: "project_ds7" }),
    ).rejects.toBeInstanceOf(PersistedWebDesignWriterContextError);
  });
});
