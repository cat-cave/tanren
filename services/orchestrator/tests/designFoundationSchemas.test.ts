// ds-0 — artifact/release/fragment schema parse + offline validator (positive +
// negative controls: traversal path, corrupt blob, digest mismatch).

import { describe, expect, it } from "vitest";
import {
  DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE,
  DESIGN_FRAGMENT_PHASES,
  DESIGN_MANIFEST_SCHEMA_VERSION,
  DesignArtifactSchemaError,
  parseDesignArtifactManifest,
  parseDesignFragmentSpec,
  parseDesignSystemRelease,
} from "../src/engine/design/system/designArtifactSchemas.js";
import {
  checkArtifactPath,
  validateArtifactManifestBlob,
  validateDesignFoundation,
} from "../src/engine/design/system/designFoundationValidator.js";
import { migrateDesignContractV1ToV2, designContractV2Digest } from "../src/engine/design/system/designContractV2.js";
import { normalizeDesignContract } from "../src/engine/design/designContract.js";

const digest = (label: string): string =>
  `sha256:${label
    .padEnd(64, "0")
    .slice(0, 64)
    .replaceAll(/[^0-9a-f]/gu, "a")}`;
void DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE;

const contract = migrateDesignContractV1ToV2(
  normalizeDesignContract({
    version: 1,
    domain: "saas-web",
    identity: "calm ops console",
    intent: "never surprises",
  }),
);
const contractDigest = designContractV2Digest(contract);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: DESIGN_MANIFEST_SCHEMA_VERSION,
    artifactId: "artifact_1",
    releaseId: "release_1",
    target: "web-react",
    contractDigest,
    plainReleaseDigest: digest("plain"),
    polishedReleaseDigest: digest("polished"),
    files: [
      { path: "manifest.json", kind: "manifest", mediaType: "application/json", digest: digest("m"), byteSize: 12 },
    ],
    fragmentLineage: ["fragment_base"],
    exports: ["css"],
    ...overrides,
  };
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    releaseId: "release_1",
    designSystemId: "system_1",
    version: 1,
    state: "draft",
    contractId: "contract_1",
    contractVersion: 1,
    contractDigest,
    manifestSchemaVersion: DESIGN_MANIFEST_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("design artifact schemas", () => {
  it("freezes the ordered fragment phases starting at base", () => {
    expect(DESIGN_FRAGMENT_PHASES[0]).toBe("base");
    expect(new Set(DESIGN_FRAGMENT_PHASES).size).toBe(DESIGN_FRAGMENT_PHASES.length);
  });

  it("parses a valid manifest, release, and fragment spec", () => {
    expect(parseDesignArtifactManifest(manifest()).artifactId).toBe("artifact_1");
    expect(parseDesignSystemRelease(release()).state).toBe("draft");
    const fragment = parseDesignFragmentSpec({
      kind: "base/plain",
      label: "Plain base",
      phase: "base",
      version: "1.0.0",
      conformanceSuiteId: "suite_base",
    });
    expect(fragment.provides).toEqual([]);
  });

  it("NEGATIVE CONTROL — a published release with no canonical artifact fails closed", () => {
    expect(() => parseDesignSystemRelease(release({ state: "published", canonicalArtifactId: null }))).toThrow(
      DesignArtifactSchemaError,
    );
  });

  it("NEGATIVE CONTROL — a bad digest / unknown key throws a typed schema error", () => {
    expect(() => parseDesignArtifactManifest(manifest({ contractDigest: "nope" }))).toThrow(DesignArtifactSchemaError);
    expect(() => parseDesignArtifactManifest(manifest({ rogue: 1 }))).toThrow(DesignArtifactSchemaError);
  });
});

describe("checkArtifactPath", () => {
  it("accepts a safe normalized path", () => {
    expect(checkArtifactPath("src/components/button.tsx")).toEqual([]);
  });

  it("NEGATIVE CONTROL — rejects traversal, absolute, and backslash paths", () => {
    expect(checkArtifactPath("../escape").length).toBeGreaterThan(0);
    expect(checkArtifactPath("/etc/passwd").length).toBeGreaterThan(0);
    expect(checkArtifactPath("a\\b").length).toBeGreaterThan(0);
    expect(checkArtifactPath("a//b").length).toBeGreaterThan(0);
  });
});

describe("validateArtifactManifestBlob + validateDesignFoundation", () => {
  it("passes a coherent manifest + release", () => {
    const { report } = validateArtifactManifestBlob(manifest(), parseDesignSystemRelease(release()));
    expect(report.ok).toBe(true);
    const whole = validateDesignFoundation({ contract, manifest: manifest(), release: release() });
    expect(whole.ok).toBe(true);
  });

  it("NEGATIVE CONTROL — a traversal file path is a P0 finding", () => {
    const bad = manifest({
      files: [
        { path: "manifest.json", kind: "manifest", mediaType: "application/json", digest: digest("m"), byteSize: 1 },
        { path: "../secret", kind: "other", mediaType: "text/plain", digest: digest("s"), byteSize: 1 },
      ],
    });
    const { report } = validateArtifactManifestBlob(bad);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === "design.artifact.path_traversal" && f.severity === "p0")).toBe(true);
  });

  it("NEGATIVE CONTROL — a manifest↔release contract-digest mismatch is a P0 finding", () => {
    const mismatched = parseDesignSystemRelease(release({ contractDigest: digest("other") }));
    const { report } = validateArtifactManifestBlob(manifest(), mismatched);
    expect(report.findings.some((f) => f.code === "design.artifact.contract_digest_mismatch")).toBe(true);
  });

  it("NEGATIVE CONTROL — a case-insensitive path collision is caught", () => {
    const collide = manifest({
      files: [
        { path: "manifest.json", kind: "manifest", mediaType: "application/json", digest: digest("m"), byteSize: 1 },
        { path: "Src/A.ts", kind: "component-source", mediaType: "text/plain", digest: digest("a"), byteSize: 1 },
        { path: "src/a.ts", kind: "component-source", mediaType: "text/plain", digest: digest("b"), byteSize: 1 },
      ],
    });
    const { report } = validateArtifactManifestBlob(collide);
    expect(report.findings.some((f) => f.code === "design.artifact.path_collision")).toBe(true);
  });
});
