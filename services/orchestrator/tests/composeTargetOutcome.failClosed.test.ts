// ds-7 — direct DB-free proof of the non-web per-target result. The real
// persistence function receives a hand-built pool and CAS; the conformance-store
// collaborator is a small in-memory object because the outcome seam accepts it.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { sha256Digest, type ArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { composeTargetOutcome } from "../src/engine/design/system/composeTargetOutcome.js";
import { buildDesignTargetAdapterSet } from "../src/engine/design/system/designTargetRegistry.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";

const DIGEST = `sha256:${"d".repeat(64)}`;
const TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#101828" },
    primary: { $type: "color", $value: "#155eef" },
  },
  radius: { md: { $type: "dimension", $value: "0.375rem" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

function memoryStore(): ArtifactStore {
  return {
    async put(bytes) {
      return sha256Digest(bytes);
    },
    async get() {
      return new Uint8Array();
    },
  };
}

function artifactPool() {
  const files: Array<{
    path: string;
    kind: string;
    mediaType: string;
    digest: string;
    byteSize: string;
    executable: boolean;
  }> = [];
  let artifact:
    | { designSystemId: string; digest: string; mediaType: string; objectStoreKey: string; byteSize: string }
    | undefined;
  const query = async (sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql.includes("INSERT INTO design_artifacts")) {
      artifact = {
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
    return { rows: [] };
  };
  return { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
}

describe("composeTargetOutcome — framework target fail-closed result", () => {
  it("returns inconclusive_infrastructure for Bevy without a native validator, never passed", async () => {
    const receipts: Array<{ readonly outcome: string }> = [];
    const adapterSet = buildDesignTargetAdapterSet(
      { designSystemId: "design_ds7", releaseId: "release_ds7", tokens: resolveDtcgTokens(TOKENS) },
      TOKENS,
    );
    const conformanceStore = {
      async record(input: { receipt: { outcome: string } }) {
        receipts.push(input.receipt);
        return {
          orgId: "org_ds7",
          projectId: "project_ds7",
          id: "conformance_bevy_ds7",
          releaseId: "release_ds7",
          artifactId: "artifact_bevy_ds7",
          target: "bevy" as const,
          adapterVersion: "tanren.bevy.v1",
          artifactDigest: DIGEST,
          receiptDigest: DIGEST,
          outcome: input.receipt.outcome,
          notes: "no native validator",
          createdAt: "2026-07-21T00:00:00.000Z",
          receipt: input.receipt,
        };
      },
    };

    const outcome = await composeTargetOutcome(
      {
        pool: artifactPool(),
        artifactStore: memoryStore(),
        fragmentAnswerer: {} as never,
        eventStore: {} as never,
        createdBy: "test",
      },
      adapterSet,
      {
        target: "bevy",
        requiredCapabilities: ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"],
        context: {
          orgId: "org_ds7",
          projectId: "project_ds7",
          designSystemId: "design_ds7",
          releaseId: "release_ds7",
          contractDigest: DIGEST,
          plainReleaseDigest: DIGEST,
          polishedReleaseDigest: DIGEST,
          fragmentLineage: [],
        },
        conformanceStore: conformanceStore as never,
      },
    );

    expect(outcome.conformanceOutcome).toBe("inconclusive_infrastructure");
    expect(outcome.conformanceOutcome).not.toBe("passed");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "inconclusive_infrastructure" });
  });
});
