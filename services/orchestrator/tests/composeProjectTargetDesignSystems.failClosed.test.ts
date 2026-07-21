// ds-7 — production multi-target composition over hand-built DB/CAS fakes. The
// Bevy adapter has no native validator, so this proves the real composer records
// the receipt and stops before publication without Postgres.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { sha256Digest, type ArtifactStore } from "../src/engine/design/system/artifactStore.js";
import {
  composeProjectTargetDesignSystems,
  RequiredDesignAdapterConformanceError,
} from "../src/engine/design/system/composeProjectTargetDesignSystems.js";

function contract() {
  return {
    version: 2,
    domain: "game",
    identity: "a native HUD",
    intent: "a fail-closed multi-target release",
    principles: [],
    constraints: [],
    personaRefs: [],
    behaviorRefs: [],
    dimensions: [],
    desiredSurfaces: [],
    targetProfiles: [
      {
        target: "bevy",
        capabilities: ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"],
        required: true,
      },
    ],
    accessibilityPosture: { standard: "none", notes: "" },
    exportRequirements: [],
    acceptanceIntent: "",
    visualVerification: { enabled: false, imageDiffThreshold: 0.01 },
  };
}

function memoryArtifactStore(): ArtifactStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const copy = new Uint8Array(bytes);
      const digest = sha256Digest(copy);
      objects.set(digest, copy);
      return digest;
    },
    async get(digest) {
      const bytes = objects.get(digest);
      if (bytes === undefined) throw new Error(`missing fake artifact ${digest}`);
      return new Uint8Array(bytes);
    },
  };
}

function composerPool() {
  const conformanceInserts: unknown[][] = [];
  const files: Array<{
    path: string;
    kind: string;
    mediaType: string;
    digest: string;
    byteSize: string;
    executable: boolean;
  }> = [];
  let artifact:
    | {
        id: string;
        designSystemId: string;
        digest: string;
        mediaType: string;
        objectStoreKey: string;
        byteSize: string;
      }
    | undefined;
  const query = async (sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql.startsWith("SELECT id, org_id, project_id, version, domain, contract FROM design_contracts")) {
      return {
        rows: [
          {
            id: "contract_ds7",
            org_id: "org_ds7",
            project_id: "project_ds7",
            version: 1,
            domain: "game",
            contract: contract(),
          },
        ],
      };
    }
    if (sql.includes("WITH head_contract AS")) return { rows: [] };
    if (
      sql.includes("SELECT DISTINCT kind, label FROM design_fragments") ||
      sql.includes("SELECT files FROM design_fragments")
    ) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO design_systems")) {
      return {
        rows: [
          {
            id: params[1],
            slug: params[2],
            name: params[3],
            description: params[4],
            lifecycle: "draft",
            default_channel: params[5],
          },
        ],
      };
    }
    if (sql.includes("INSERT INTO design_system_releases")) {
      return {
        rows: [
          {
            id: params[1],
            design_system_id: params[2],
            version: params[3],
            parent_release_id: params[4],
            state: "draft",
            contract_id: params[5],
            contract_version: params[6],
            contract_digest: params[7],
            manifest_schema_version: params[8],
            canonical_artifact_id: null,
            compatibility_summary: {},
          },
        ],
      };
    }
    if (sql.includes("INSERT INTO design_artifacts")) {
      artifact = {
        id: String(params[1]),
        designSystemId: String(params[2]),
        digest: String(params[3]),
        mediaType: String(params[4]),
        objectStoreKey: String(params[5]),
        byteSize: String(params[6]),
      };
      return { rows: [] };
    }
    if (sql.includes("SELECT design_system_id, digest, media_type")) {
      return {
        rows:
          artifact === undefined
            ? []
            : [
                {
                  design_system_id: artifact.designSystemId,
                  digest: artifact.digest,
                  media_type: artifact.mediaType,
                  object_store_key: artifact.objectStoreKey,
                  byte_size: artifact.byteSize,
                },
              ],
      };
    }
    if (sql.includes("INSERT INTO design_artifact_files")) {
      files.push({
        path: String(params[2]),
        kind: String(params[3]),
        mediaType: String(params[4]),
        digest: String(params[5]),
        byteSize: String(params[6]),
        executable: Boolean(params[7]),
      });
      return { rows: [] };
    }
    if (sql.includes("SELECT path, kind, media_type, digest, byte_size, executable")) {
      return {
        rows: files.map((file) => ({
          path: file.path,
          kind: file.kind,
          media_type: file.mediaType,
          digest: file.digest,
          byte_size: file.byteSize,
          executable: file.executable,
        })),
      };
    }
    if (sql.includes("SELECT digest FROM design_artifacts"))
      return { rows: artifact === undefined ? [] : [{ digest: artifact.digest }] };
    if (sql.includes("INSERT INTO design_adapter_conformance_runs")) {
      conformanceInserts.push([...params]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  return {
    pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    conformanceInserts,
  };
}

describe("composeProjectTargetDesignSystems — required target publication guard", () => {
  it("records the real Bevy inconclusive receipt and blocks publishRelease", async () => {
    const { pool, conformanceInserts } = composerPool();

    await expect(
      composeProjectTargetDesignSystems(
        {
          pool,
          artifactStore: memoryArtifactStore(),
          fragmentAnswerer: {} as never,
          eventStore: {} as never,
          createdBy: "test",
        },
        { orgId: "org_ds7", projectId: "project_ds7" },
      ),
    ).rejects.toBeInstanceOf(RequiredDesignAdapterConformanceError);

    expect(conformanceInserts).toHaveLength(1);
    expect(conformanceInserts[0]?.[10]).toBe("inconclusive_infrastructure");
    expect(JSON.parse(String(conformanceInserts[0]?.[9]))).toMatchObject({ outcome: "inconclusive_infrastructure" });
  });
});
