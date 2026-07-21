// ds-7 — the adversarial conformance suite for every framework adapter. Each
// target must PASS its own positive cases AND FAIL its negative controls
// decisively. The receipt's `passed` outcome requires EVERY critical proof +
// negative control to match — a removed capability, an altered native resource,
// or a failed renderer yields `failed` / `inconclusive`, NEVER a partial pass.
//
// These are DB-free unit tests so the fail-closed arms are covered without
// Postgres (RLS-gated tests don't count toward CI statement coverage).

import { describe, expect, it } from "vitest";
import {
  type DesignAdapterConformanceReceiptV1,
  type DesignAdapterConformanceTarget,
  receiptPasses,
} from "../src/engine/design/system/adapterConformanceReceipt.js";
import { type FrameworkDesignTargetAdapter } from "../src/engine/design/system/frameworkAdapterCore.js";
import { staticCheck } from "../src/engine/design/system/frameworkStaticCheck.js";
import { buildBevyAdapter } from "../src/engine/design/system/bevyAdapter.js";
import { buildSwiftUiAdapter } from "../src/engine/design/system/swiftUiAdapter.js";
import { buildJetpackComposeAdapter } from "../src/engine/design/system/jetpackComposeAdapter.js";
import { buildFlutterAdapter } from "../src/engine/design/system/flutterAdapter.js";
import { buildReactNativeAdapter } from "../src/engine/design/system/reactNativeAdapter.js";
import { buildGenericWebAdapter } from "../src/engine/design/system/genericWebAdapter.js";
import { buildDocumentMediaAdapter } from "../src/engine/design/system/documentMediaAdapter.js";
import { recordFrameworkConformanceRun } from "../src/engine/design/system/composeProjectTargetDesignSystemsHelpers.js";
import { DesignVfs } from "../src/engine/design/system/designVfs.js";

const PLAIN_BASE_TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#101828" },
    border: { $type: "color", $value: "#d0d5dd" },
    primary: { $type: "color", $value: "#155eef" },
  },
  radius: { md: { $type: "dimension", $value: "0.375rem" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

const TARGETS: ReadonlyArray<{
  readonly target: DesignAdapterConformanceTarget;
  readonly build: () => FrameworkDesignTargetAdapter;
}> = [
  { target: "bevy", build: () => buildBevyAdapter(PLAIN_BASE_TOKENS) },
  { target: "swiftui", build: () => buildSwiftUiAdapter(PLAIN_BASE_TOKENS) },
  { target: "jetpack-compose", build: () => buildJetpackComposeAdapter(PLAIN_BASE_TOKENS) },
  { target: "flutter", build: () => buildFlutterAdapter(PLAIN_BASE_TOKENS) },
  { target: "react-native", build: () => buildReactNativeAdapter(PLAIN_BASE_TOKENS) },
  { target: "generic-web", build: () => buildGenericWebAdapter(PLAIN_BASE_TOKENS) },
  { target: "document-media", build: () => buildDocumentMediaAdapter(PLAIN_BASE_TOKENS) },
];

describe.each(TARGETS)("framework adapter — $target", ({ target, build }) => {
  const artifactDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

  it("projects contract-required capabilities but remains inconclusive without a native validator", async () => {
    const adapter = build();
    const receipt = await recordFrameworkConformanceRun(adapter, {
      artifactDigest,
      adapterVersion: `tanren.${target}.v1`,
      requiredCapabilities: ["tokens", "catalog", "components"],
    });
    expect(receipt.target).toBe(target);
    expect(receipt.requiredCapabilities).toEqual(["tokens", "catalog", "components"]);
    expect(receipt.resolvedCapabilities).toHaveLength(receipt.requiredCapabilities.length);
    for (const resolved of receipt.resolvedCapabilities) {
      expect(resolved.supported).toBe(true);
      expect(resolved.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
    expect(receipt.outcome).toBe("inconclusive_infrastructure");
    expect(receiptPasses(receipt)).toBe(false);
  });

  it("NEGATIVE CONTROL — a missing token file is flagged p0 (validator catches the regression)", async () => {
    const adapter = build();
    const descriptors = adapter.descriptors();
    const tokenFile = adapter.files().find((file) => file.kind === "tokens");
    expect(tokenFile).toBeDefined();
    const injected = new DesignVfs(descriptors.filter((descriptor) => descriptor.path !== tokenFile!.path));
    const result = staticCheck(target, descriptors, injected);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === `${target}.artifact_file_missing`)).toBe(true);
  });

  it("NEGATIVE CONTROL — a drifted digest on any file is flagged p0 (validator catches tampering)", async () => {
    const adapter = build();
    const descriptors = adapter.descriptors();
    const tampered = descriptors.map((descriptor) =>
      descriptor.path === descriptors[0]!.path
        ? { ...descriptor, digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111" }
        : descriptor,
    );
    const injected = new DesignVfs(tampered);
    const result = staticCheck(target, descriptors, injected);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === `${target}.artifact_file_digest_mismatch`)).toBe(true);
  });

  it("NEGATIVE CONTROL — every negative control in the suite is caught by the validator", async () => {
    const adapter = build();
    const receipt = await recordFrameworkConformanceRun(adapter, {
      artifactDigest,
      adapterVersion: `tanren.${target}.v1`,
      requiredCapabilities: ["tokens", "catalog", "components"],
    });
    expect(receipt.negativeControls.length).toBeGreaterThanOrEqual(2);
    for (const control of receipt.negativeControls) {
      expect(control.passed).toBe(true);
    }
    expect(receiptPasses(receipt)).toBe(false);
  });

  it("enumerates proof requirements including a CRITICAL build + render + export", async () => {
    const adapter = build();
    const requirements = await adapter.enumerateProofRequirements({
      target,
      capabilities: [],
    });
    expect(requirements.some((requirement) => requirement.kind === "build" && requirement.critical)).toBe(true);
    expect(requirements.some((requirement) => requirement.kind === "render" && requirement.critical)).toBe(true);
    expect(requirements.some((requirement) => requirement.kind === "export" && requirement.critical)).toBe(true);
  });

  it("renderScenarioMatrix requires a static-valid VFS (a broken VFS is LOUD)", async () => {
    const adapter = build();
    const broken = new DesignVfs([]);
    await expect(adapter.renderScenarioMatrix(broken, { target, capabilities: [] })).rejects.toThrow(
      new RegExp(`${target}.*static`, "u"),
    );
  });

  it("detectTarget returns the satisfied capability set when target files are present", async () => {
    const adapter = build();
    const detection = await adapter.detectTarget({
      root: "/tmp/test",
      listFiles: async () => adapter.files().map((file) => file.path),
    });
    expect(detection.applies).toBe(true);
    expect(detection.satisfiedCapabilities.length).toBeGreaterThan(0);
    expect(detection.unsatisfiedCapabilities).toEqual([]);
  });

  it("detectTarget returns unsatisfied when no target files are present", async () => {
    const adapter = build();
    const detection = await adapter.detectTarget({
      root: "/tmp/test",
      listFiles: async () => ["README.md"],
    });
    expect(detection.applies).toBe(false);
    expect(detection.unsatisfiedCapabilities.length).toBeGreaterThan(0);
  });

  it("export() fails LOUDLY for an unsupported format (typed F2D gap)", async () => {
    const adapter = build();
    await expect(
      adapter.export("unsupported-format", {
        manifestVersion: 1,
        artifactId: "a",
        releaseId: "r",
        target,
        contractDigest: artifactDigest,
        plainReleaseDigest: artifactDigest,
        polishedReleaseDigest: artifactDigest,
        files: [],
        fragmentLineage: [],
        exports: [],
        proofDigests: {},
      }),
    ).rejects.toThrow(/capability/u);
  });

  it("export() fails LOUDLY when the manifest target does not match the adapter", async () => {
    const adapter = build();
    const wrongTarget = target === "bevy" ? "swiftui" : "bevy";
    await expect(
      adapter.export("any", {
        manifestVersion: 1,
        artifactId: "a",
        releaseId: "r",
        target: wrongTarget,
        contractDigest: artifactDigest,
        plainReleaseDigest: artifactDigest,
        polishedReleaseDigest: artifactDigest,
        files: [],
        fragmentLineage: [],
        exports: [],
        proofDigests: {},
      }),
    ).rejects.toThrow(/capability/u);
  });
});

describe("receiptPasses — vacuous-truth + multiset defense (trap #4)", () => {
  const baseReceipt: DesignAdapterConformanceReceiptV1 = {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: "bevy",
    adapterVersion: "tanren.bevy.v1",
    artifactDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    scenarioMatrixDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    requiredCapabilities: ["tokens", "catalog"],
    resolvedCapabilities: [
      {
        capability: "tokens",
        supported: true,
        evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      {
        capability: "catalog",
        supported: true,
        evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    ],
    criticalProofs: [
      {
        key: "p",
        kind: "build",
        evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        passed: true,
      },
    ],
    positiveCases: [
      {
        key: "p",
        description: "d",
        evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        passed: true,
      },
    ],
    negativeControls: [{ key: "n", description: "d", expectFindingCode: "x", passed: true }],
    outcome: "passed",
    notes: "",
  };

  it("an empty required-capability set NEVER passes (no vacuous truth)", () => {
    expect(receiptPasses({ ...baseReceipt, requiredCapabilities: [] })).toBe(false);
  });

  it("a resolved-but-unsupported capability NEVER passes", () => {
    expect(
      receiptPasses({
        ...baseReceipt,
        resolvedCapabilities: [
          {
            capability: "tokens",
            supported: true,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
          {
            capability: "catalog",
            supported: false,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        ],
      }),
    ).toBe(false);
  });

  it("a missing required capability NEVER passes (multiset exact match)", () => {
    expect(
      receiptPasses({
        ...baseReceipt,
        resolvedCapabilities: [
          {
            capability: "tokens",
            supported: true,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        ],
      }),
    ).toBe(false);
  });

  it("an extra resolved capability NEVER passes (multiset exact match)", () => {
    expect(
      receiptPasses({
        ...baseReceipt,
        resolvedCapabilities: [
          {
            capability: "tokens",
            supported: true,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
          {
            capability: "catalog",
            supported: true,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
          {
            capability: "extra",
            supported: true,
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
        ],
      }),
    ).toBe(false);
  });

  it("a non-passed critical proof / positive / negative control NEVER passes", () => {
    expect(
      receiptPasses({
        ...baseReceipt,
        criticalProofs: [
          {
            key: "p",
            kind: "build",
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            passed: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      receiptPasses({
        ...baseReceipt,
        positiveCases: [
          {
            key: "p",
            description: "d",
            evidenceDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            passed: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      receiptPasses({
        ...baseReceipt,
        negativeControls: [{ key: "n", description: "d", expectFindingCode: "x", passed: false }],
      }),
    ).toBe(false);
  });

  it("a non-passed outcome label NEVER passes (even when every proof is otherwise green)", () => {
    expect(receiptPasses({ ...baseReceipt, outcome: "failed" })).toBe(false);
    expect(receiptPasses({ ...baseReceipt, outcome: "inconclusive_infrastructure" })).toBe(false);
  });
});

describe("registry — adapter registration + resolution", () => {
  it("registers every framework adapter and resolves them through the registry", async () => {
    const { buildDesignTargetAdapterSet } = await import("../src/engine/design/system/designTargetRegistry.js");
    const { resolveDtcgTokens } = await import("../src/engine/design/system/dtcgResolver.js");
    const set = buildDesignTargetAdapterSet(
      {
        designSystemId: "ds",
        releaseId: "r",
        tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS),
      },
      PLAIN_BASE_TOKENS,
    );
    expect(set.registry.registeredTargets().sort()).toEqual(
      [
        "web-react",
        "generic-web",
        "bevy",
        "swiftui",
        "jetpack-compose",
        "flutter",
        "react-native",
        "document-media",
      ].sort(),
    );
    // Resolving every target succeeds — none is a stub.
    for (const target of set.registry.registeredTargets()) {
      const adapter = set.registry.resolve(target);
      expect(adapter.target).toBe(target);
    }
  });

  it("NEGATIVE CONTROL — resolving an unregistered target is a LOUD typed error", async () => {
    const { DesignTargetAdapterRegistry, DesignAdapterNotRegisteredError } =
      await import("../src/engine/design/system/designTargetAdapter.js");
    const registry = new DesignTargetAdapterRegistry();
    expect(() => registry.resolve("web-react")).toThrow(DesignAdapterNotRegisteredError);
  });
});
