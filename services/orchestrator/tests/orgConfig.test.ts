import { describe, expect, it } from "vitest";
import {
  OrgConfigV1,
  RoleId,
  SUPPORTED_ORG_CONFIG_VERSIONS,
  UnknownConfigVersionError,
  defaultOrgConfigV1,
  migrateOrgConfig,
  orgConfigJsonSchema
} from "../src/engine/config/index.js";

function captureOrgMigrationError(raw: unknown): UnknownConfigVersionError {
  try {
    migrateOrgConfig(raw);
  } catch (error) {
    if (error instanceof UnknownConfigVersionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected migrateOrgConfig to throw UnknownConfigVersionError");
}

describe("OrgConfigV1 parser", () => {
  it("fills defaults for an empty object", () => {
    const cfg = migrateOrgConfig({});
    expect(cfg.version).toBe(1);
    expect(cfg.auditGateEnabled).toBe(false);
    expect(cfg.notificationTargets).toEqual([]);
    expect(cfg.escapeHatches).toEqual({
      maxWriterIterPerSubtask: 5,
      maxPlannerRerunsPerSpec: 3,
      maxRetriesPerTransientFailure: 3,
      maxSpecDiscoveryRoundsWithForge: 20
    });
    expect(cfg.allocator).toEqual({
      kind: "local-docker",
      concurrency: 3,
      memoryMb: 4096,
      cpus: 2,
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0"
    });
    expect(cfg.forgePersona).toEqual({ systemPromptOverride: null, enableTools: [] });
  });

  it("represents all six roles with empty chains by default", () => {
    const cfg = migrateOrgConfig({});
    for (const role of RoleId.options) {
      expect(cfg.routing[role]).toEqual({ chain: [] });
    }
  });

  it("parses an org with a Codex-only single-entry chain for write", () => {
    const cfg = migrateOrgConfig({
      version: 1,
      routing: {
        write: { chain: [{ cli: "codex", model: "gpt-5", authRef: "vault://codex-prod" }] }
      }
    });
    expect(cfg.routing.write.chain).toHaveLength(1);
    expect(cfg.routing.write.chain[0]?.cli).toBe("codex");
  });

  it("accepts an audit gate toggle", () => {
    const cfg = migrateOrgConfig({ version: 1, auditGateEnabled: true });
    expect(cfg.auditGateEnabled).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    expect(() => migrateOrgConfig({ version: 1, extraKey: true })).toThrow(/.+/);
  });

  it("rejects an invalid allocator kind", () => {
    expect(() => migrateOrgConfig({ version: 1, allocator: { kind: "hetzner" } })).toThrow(/.+/);
  });

  it("is idempotent on a V1-shaped input", () => {
    const first = migrateOrgConfig({});
    const second = migrateOrgConfig(first);
    expect(second).toEqual(first);
  });

  it("throws UnknownConfigVersionError on a future version", () => {
    const caught = captureOrgMigrationError({ version: 99 });
    expect(caught).toBeInstanceOf(UnknownConfigVersionError);
    expect(caught.observedVersion).toBe(99);
    expect(caught.supportedVersions).toEqual(SUPPORTED_ORG_CONFIG_VERSIONS);
  });

  it("treats a missing version as legacy and yields V1 defaults", () => {
    const cfg = migrateOrgConfig({ someLegacyKey: "ignored" });
    expect(cfg).toEqual(defaultOrgConfigV1());
  });
});

describe("OrgConfigV1 Zod default", () => {
  it("matches the migration helper output", () => {
    expect(OrgConfigV1.parse({ version: 1 })).toEqual(defaultOrgConfigV1());
  });
});

describe("OrgConfigV1 JSON Schema export", () => {
  it("exposes a JSON Schema document", () => {
    const schema = orgConfigJsonSchema();
    expect(schema).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema)).toContain("auditGateEnabled");
  });
});
