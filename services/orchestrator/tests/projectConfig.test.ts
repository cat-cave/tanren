import { describe, expect, it } from "vitest";
import {
  ProjectConfigV1,
  RoleId,
  SUPPORTED_PROJECT_CONFIG_VERSIONS,
  UnknownConfigVersionError,
  defaultProjectConfigV1,
  migrateProjectConfig,
  projectConfigJsonSchema,
} from "../src/engine/config/index.js";

function captureProjectMigrationError(raw: unknown): UnknownConfigVersionError {
  try {
    migrateProjectConfig(raw);
  } catch (error) {
    if (error instanceof UnknownConfigVersionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected migrateProjectConfig to throw UnknownConfigVersionError");
}

describe("ProjectConfigV1 parser", () => {
  it("fills defaults for a bare version:1 object", () => {
    const cfg = migrateProjectConfig({ version: 1 });
    expect(cfg.version).toBe(1);
    expect(cfg.governancePosture).toBe("strict");
    expect(cfg.mergeIntegration).toBe("not_configured");
    expect(cfg.reviewPolicy).toBe("human");
    expect(cfg.notificationTargets).toEqual([]);
    expect(cfg.forgePersona).toEqual({});
    expect(cfg.escapeHatches).toEqual({});
    expect(cfg.allocator).toEqual({});
  });

  it("represents all six roles in the routing table with empty chains by default", () => {
    const cfg = migrateProjectConfig({ version: 1 });
    for (const role of RoleId.options) {
      expect(cfg.routing[role]).toEqual({ chain: [] });
    }
  });

  it("parses a V1 with a single-entry chain for one role", () => {
    const cfg = migrateProjectConfig({
      version: 1,
      routing: {
        write: { chain: [{ cli: "codex", model: "gpt-5", authRef: "vault://codex" }] },
      },
    });
    expect(cfg.routing.write.chain).toHaveLength(1);
    expect(cfg.routing.write.chain[0]).toMatchObject({
      cli: "codex",
      model: "gpt-5",
      authRef: "vault://codex",
    });
    // Other roles still default to empty chains.
    expect(cfg.routing.plan.chain).toEqual([]);
  });

  it("parses multi-entry chains and all six roles populated", () => {
    const raw = {
      version: 1,
      routing: Object.fromEntries(
        RoleId.options.map((role) => [
          role,
          {
            chain: [
              { cli: "codex", model: "gpt-5", authRef: "vault://primary" },
              {
                cli: "claude",
                model: "haiku-4.5",
                authRef: "vault://secondary",
                healthHint: "warn",
              },
            ],
          },
        ]),
      ),
    };
    const cfg = migrateProjectConfig(raw);
    for (const role of RoleId.options) {
      expect(cfg.routing[role].chain).toHaveLength(2);
      expect(cfg.routing[role].chain[1]?.healthHint).toBe("warn");
    }
  });

  it("rejects unknown top-level fields with a typed parse error", () => {
    expect(() => migrateProjectConfig({ version: 1, somethingElse: 42 })).toThrow(/.+/u);
  });

  it("rejects unknown fields inside a routing chain entry", () => {
    expect(() =>
      migrateProjectConfig({
        version: 1,
        routing: {
          write: { chain: [{ cli: "codex", model: "gpt-5", authRef: "x", extra: true }] },
        },
      }),
    ).toThrow(/.+/u);
  });

  it("accepts partial escape hatches that override only one budget", () => {
    const cfg = migrateProjectConfig({
      version: 1,
      escapeHatches: { maxWriterIterPerSubtask: 9 },
    });
    expect(cfg.escapeHatches.maxWriterIterPerSubtask).toBe(9);
    // Other fields remain unspecified (project layer is partial); merge with
    // org defaults happens at the engine layer.
    expect(cfg.escapeHatches.maxPlannerRerunsPerSpec).toBeUndefined();
  });

  it("rejects negative numeric escape hatches", () => {
    expect(() => migrateProjectConfig({ version: 1, escapeHatches: { maxWriterIterPerSubtask: 0 } })).toThrow(/.+/u);
  });

  it("accepts a governance posture and merge integration override", () => {
    const cfg = migrateProjectConfig({
      version: 1,
      governancePosture: "audit_only",
      mergeIntegration: "native_queue",
    });
    expect(cfg.governancePosture).toBe("audit_only");
    expect(cfg.mergeIntegration).toBe("native_queue");
  });

  it("rejects the removed `mergify_queue` merge integration (no-legacy fail-hard)", () => {
    // P2e-2: Mergify is gone. A stored config that still names `mergify_queue`
    // must FAIL the versioned parse — never be silently coerced to another mode.
    expect(() => migrateProjectConfig({ version: 1, mergeIntegration: "mergify_queue" })).toThrow(/.+/u);
  });

  it("defaults reviewPolicy to human and accepts an auto override", () => {
    expect(migrateProjectConfig({ version: 1 }).reviewPolicy).toBe("human");
    expect(migrateProjectConfig({ version: 1, reviewPolicy: "auto" }).reviewPolicy).toBe("auto");
  });

  it("rejects an unknown reviewPolicy value", () => {
    expect(() => migrateProjectConfig({ version: 1, reviewPolicy: "nobody" })).toThrow(/.+/u);
  });

  it("accepts notification target refs as uuids", () => {
    const ref = "11111111-1111-4111-8111-111111111111";
    const cfg = migrateProjectConfig({
      version: 1,
      notificationTargets: [ref],
    });
    expect(cfg.notificationTargets).toEqual([ref]);
  });

  it("rejects non-uuid notification target refs", () => {
    expect(() => migrateProjectConfig({ version: 1, notificationTargets: ["not-a-uuid"] })).toThrow(/.+/u);
  });

  it("omits the credentials field when none is bound", () => {
    const cfg = migrateProjectConfig({ version: 1 });
    expect(cfg.credentials).toBeUndefined();
  });

  it("parses bound credential refs and round-trips them", () => {
    const cfg = migrateProjectConfig({
      version: 1,
      credentials: {
        codexCredentialRef: "credential/codex/org/o/p",
        githubCredentialRef: "credential/github/org/o/p",
      },
    });
    expect(cfg.credentials).toEqual({
      codexCredentialRef: "credential/codex/org/o/p",
      githubCredentialRef: "credential/github/org/o/p",
    });
    expect(migrateProjectConfig(cfg)).toEqual(cfg);
  });

  it("accepts a credentials object binding only one kind", () => {
    const cfg = migrateProjectConfig({
      version: 1,
      credentials: { githubCredentialRef: "credential/github/org/o/p" },
    });
    expect(cfg.credentials).toEqual({ githubCredentialRef: "credential/github/org/o/p" });
  });

  it("rejects unknown keys inside the credentials object", () => {
    expect(() => migrateProjectConfig({ version: 1, credentials: { somethingElse: "x" } })).toThrow(/.+/u);
  });

  it("rejects an empty-string credential ref", () => {
    expect(() => migrateProjectConfig({ version: 1, credentials: { codexCredentialRef: "" } })).toThrow(/.+/u);
  });

  it("is idempotent on a V1-shaped input (V1 -> V1)", () => {
    const first = migrateProjectConfig({ version: 1 });
    const second = migrateProjectConfig(first);
    expect(second).toEqual(first);
  });

  it("throws UnknownConfigVersionError on a future version", () => {
    const caught = captureProjectMigrationError({ version: 2 });
    expect(caught).toBeInstanceOf(UnknownConfigVersionError);
    expect(caught.observedVersion).toBe(2);
    expect(caught.supportedVersions).toEqual(SUPPORTED_PROJECT_CONFIG_VERSIONS);
  });

  it("fails hard on an unversioned row (no silent default)", () => {
    // The migration shim that upgraded a versionless/`{}` row into V1 defaults
    // is deleted: an unversioned config is now a hard error.
    const caughtEmpty = captureProjectMigrationError({});
    expect(caughtEmpty).toBeInstanceOf(UnknownConfigVersionError);
    expect(caughtEmpty.observedVersion).toBeUndefined();
    expect(caughtEmpty.supportedVersions).toEqual(SUPPORTED_PROJECT_CONFIG_VERSIONS);

    const caughtAdHoc = captureProjectMigrationError({ budgetUsd: 25 });
    expect(caughtAdHoc).toBeInstanceOf(UnknownConfigVersionError);
    expect(caughtAdHoc.observedVersion).toBeUndefined();
  });

  it("exposes a fully-defaulted V1 via defaultProjectConfigV1()", () => {
    expect(defaultProjectConfigV1()).toEqual(migrateProjectConfig({ version: 1 }));
  });
});

describe("ProjectConfigV1 JSON Schema export", () => {
  it("exposes a JSON Schema document with the V1 version literal", () => {
    const schema = projectConfigJsonSchema();
    expect(schema).toMatchObject({ type: "object" });
    // The JSON Schema artifact is for human documentation; we just assert
    // the shape is producible and references the V1 discriminator.
    expect(JSON.stringify(schema)).toContain("version");
  });
});

describe("ProjectConfigV1 Zod default surface", () => {
  it("matches the parsed default", () => {
    expect(ProjectConfigV1.parse({ version: 1 })).toEqual(defaultProjectConfigV1());
  });
});

describe("ProjectConfigV1 speculation knobs (P2c-1, §2c)", () => {
  it("defaults speculationThreshold to moderate + depth to 2 (legacy rows parse cleanly)", () => {
    const parsed = migrateProjectConfig({ version: 1 });
    expect(parsed.speculationThreshold).toBe("moderate");
    expect(parsed.speculativeIntegrationDepth).toBe(2);
  });

  it("round-trips an explicit threshold + depth", () => {
    const parsed = migrateProjectConfig({
      version: 1,
      speculationThreshold: "aggressive",
      speculativeIntegrationDepth: 4,
    });
    expect(parsed.speculationThreshold).toBe("aggressive");
    expect(parsed.speculativeIntegrationDepth).toBe(4);
  });

  it("rejects an unknown threshold + a non-positive depth", () => {
    expect(() => migrateProjectConfig({ version: 1, speculationThreshold: "yolo" })).toThrow(/invalid|expected|enum/iu);
    expect(() => migrateProjectConfig({ version: 1, speculativeIntegrationDepth: 0 })).toThrow(
      /greater|min|>=|positive/iu,
    );
  });
});
