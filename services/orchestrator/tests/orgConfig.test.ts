import { describe, expect, it } from "vitest";
import {
  MissingConfigVersionError,
  OrgConfigV1,
  RoleId,
  SUPPORTED_ORG_CONFIG_VERSIONS,
  UnknownConfigVersionError,
  defaultOrgConfigV1,
  migrateOrgConfig,
  orgConfigJsonSchema,
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

function captureOrgMissingVersionError(raw: unknown): MissingConfigVersionError {
  try {
    migrateOrgConfig(raw);
  } catch (error) {
    if (error instanceof MissingConfigVersionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected migrateOrgConfig to throw MissingConfigVersionError");
}

describe("OrgConfigV1 parser", () => {
  it("fills defaults for an explicit V1 with no other fields", () => {
    const cfg = migrateOrgConfig({ version: 1 });
    expect(cfg.version).toBe(1);
    expect(cfg.auditGateEnabled).toBe(false);
    expect(cfg.notificationTargets).toEqual([]);
    expect(cfg.escapeHatches).toEqual({
      maxWriterIterPerSubtask: 5,
      maxPlannerRerunsPerSpec: 3,
      maxRetriesPerTransientFailure: 3,
      maxSpecDiscoveryRoundsWithForge: 20,
    });
    expect(cfg.allocator).toEqual({
      kind: "local-docker",
      concurrency: 3,
      memoryMb: 4096,
      cpus: 2,
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });
    expect(cfg.forgePersona).toEqual({ systemPromptOverride: null, enableTools: [] });
  });

  it("represents all six roles with empty chains by default", () => {
    const cfg = migrateOrgConfig({ version: 1 });
    for (const role of RoleId.options) {
      expect(cfg.routing[role]).toEqual({ chain: [] });
    }
  });

  it("parses an org with a Codex-only single-entry chain for write", () => {
    const cfg = migrateOrgConfig({
      version: 1,
      routing: {
        write: { chain: [{ cli: "codex", model: "gpt-5", authRef: "vault://codex-prod" }] },
      },
    });
    expect(cfg.routing.write.chain).toHaveLength(1);
    expect(cfg.routing.write.chain[0]?.cli).toBe("codex");
  });

  it("accepts an audit gate toggle", () => {
    const cfg = migrateOrgConfig({ version: 1, auditGateEnabled: true });
    expect(cfg.auditGateEnabled).toBe(true);
  });

  it("accepts a P3-0017 audit-gate target, defaulting branch/file", () => {
    const cfg = migrateOrgConfig({
      version: 1,
      auditGateEnabled: true,
      auditGate: { repo: "cat-cave/tanren-config" },
    });
    expect(cfg.auditGate?.repo).toBe("cat-cave/tanren-config");
    expect(cfg.auditGate?.baseBranch).toBe("main");
    expect(cfg.auditGate?.branchPrefix).toBe("forge");
    expect(cfg.auditGate?.configFile).toBe("tanren.yaml");
  });

  it("rejects an audit-gate repo that is not owner/name", () => {
    expect(() => migrateOrgConfig({ version: 1, auditGate: { repo: "no-slash" } })).toThrow(/.+/u);
  });

  it("rejects unknown top-level fields", () => {
    expect(() => migrateOrgConfig({ version: 1, extraKey: true })).toThrow(/.+/u);
  });

  it("rejects an invalid allocator kind", () => {
    expect(() => migrateOrgConfig({ version: 1, allocator: { kind: "hetzner" } })).toThrow(/.+/u);
  });

  it("omits defaultCredentials when none is set", () => {
    expect(migrateOrgConfig({ version: 1 }).defaultCredentials).toBeUndefined();
  });

  it("parses per-kind default credential refs and round-trips them", () => {
    const cfg = migrateOrgConfig({
      version: 1,
      defaultCredentials: {
        codex_chatgpt_auth: "credential/codex/org/o/default",
        github_token: "credential/github/org/o/default",
      },
    });
    expect(cfg.defaultCredentials).toEqual({
      codex_chatgpt_auth: "credential/codex/org/o/default",
      github_token: "credential/github/org/o/default",
    });
    expect(migrateOrgConfig(cfg)).toEqual(cfg);
  });

  it("rejects unknown keys inside defaultCredentials", () => {
    expect(() => migrateOrgConfig({ version: 1, defaultCredentials: { gitlab_token: "x" } })).toThrow(/.+/u);
  });

  it("is idempotent on a V1-shaped input", () => {
    const first = migrateOrgConfig({ version: 1 });
    const second = migrateOrgConfig(first);
    expect(second).toEqual(first);
  });

  it("throws UnknownConfigVersionError on a future version", () => {
    const caught = captureOrgMigrationError({ version: 99 });
    expect(caught).toBeInstanceOf(UnknownConfigVersionError);
    expect(caught.observedVersion).toBe(99);
    expect(caught.supportedVersions).toEqual(SUPPORTED_ORG_CONFIG_VERSIONS);
  });

  it("fails hard on a versionless row (no silent legacy migration)", () => {
    expect(() => migrateOrgConfig({})).toThrow(MissingConfigVersionError);
    expect(() => migrateOrgConfig({ someLegacyKey: "ignored" })).toThrow(MissingConfigVersionError);
  });

  it("MissingConfigVersionError reports the supported versions", () => {
    const caught = captureOrgMissingVersionError({});
    expect(caught.supportedVersions).toEqual(SUPPORTED_ORG_CONFIG_VERSIONS);
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
