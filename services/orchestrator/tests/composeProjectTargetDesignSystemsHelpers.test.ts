// ds-7 — DB-free unit tests for the multi-target composer's pure helpers.
// Covers the fail-closed arms (validator helpers, manifest encoding, framework
// artifact build) without Postgres so they count toward CI statement coverage.

import { describe, expect, it } from "vitest";
import { buildBevyAdapter } from "../src/engine/design/system/bevyAdapter.js";
import { sha256Digest } from "../src/engine/design/system/artifactStore.js";
import {
  buildFrameworkArtifact,
  buildWebAdapterForF2d,
  buildWebConformanceReceipt,
  digestOf,
  encodeFrameworkManifest,
  newConformanceRunId,
  newTargetArtifactId,
  recordFrameworkConformanceRun,
  resolveFrameworkAdapter,
} from "../src/engine/design/system/composeProjectTargetDesignSystemsHelpers.js";
import { buildDesignTargetAdapterSet } from "../src/engine/design/system/designTargetRegistry.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";
import {
  parseDesignAdapterConformanceReceipt,
  receiptPasses,
} from "../src/engine/design/system/adapterConformanceReceipt.js";

const PLAIN_BASE_TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#101828" },
    border: { $type: "color", $value: "#d0d5dd" },
    primary: { $type: "color", $value: "#155eef" },
    muted: { $type: "color", $value: "#e9e7ec" },
  },
  radius: { md: { $type: "dimension", $value: "0.375rem" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

describe("composeProjectTargetDesignSystemsHelpers — pure helpers", () => {
  it("digestOf produces a stable sha256 over a canonical body", () => {
    const a = digestOf(["tanren.x", { foo: 1 }]);
    const b = digestOf(["tanren.x", { foo: 1 }]);
    const c = digestOf(["tanren.x", { foo: 2 }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("newTargetArtifactId + newConformanceRunId stamp the target into the id", () => {
    const id = newTargetArtifactId("bevy");
    expect(id).toMatch(/^design_bevy_artifact_[0-9a-f-]+/u);
    const runId = newConformanceRunId("swiftui");
    expect(runId).toMatch(/^conformance_swiftui_[0-9a-f-]+/u);
  });

  it("encodeFrameworkManifest round-trips a FrameworkArtifactBuildResult as JSON bytes", () => {
    const adapter = buildBevyAdapter(PLAIN_BASE_TOKENS);
    const artifact = buildFrameworkArtifact(adapter, {
      artifactId: "art_1",
      releaseId: "rel_1",
      target: "bevy",
      contractDigest: digestOf("contract-1"),
      plainReleaseDigest: digestOf("plain-1"),
      polishedReleaseDigest: digestOf("polished-1"),
      fragmentLineage: ["frag_a", "frag_b"],
    });
    const bytes = encodeFrameworkManifest(artifact);
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as { target: string; artifactId: string; files: unknown[] };
    expect(parsed.target).toBe("bevy");
    expect(parsed.artifactId).toBe("art_1");
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it("resolveFrameworkAdapter returns the matching handle for every framework target", () => {
    const set = buildDesignTargetAdapterSet(
      { designSystemId: "ds", releaseId: "r", tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS) },
      PLAIN_BASE_TOKENS,
    );
    expect(resolveFrameworkAdapter(set, "bevy").target).toBe("bevy");
    expect(resolveFrameworkAdapter(set, "swiftui").target).toBe("swiftui");
    expect(resolveFrameworkAdapter(set, "jetpack-compose").target).toBe("jetpack-compose");
    expect(resolveFrameworkAdapter(set, "flutter").target).toBe("flutter");
    expect(resolveFrameworkAdapter(set, "react-native").target).toBe("react-native");
    expect(resolveFrameworkAdapter(set, "generic-web").target).toBe("generic-web");
    expect(resolveFrameworkAdapter(set, "document-media").target).toBe("document-media");
  });

  it("resolveFrameworkAdapter throws for web-react (only framework targets are reachable)", () => {
    const set = buildDesignTargetAdapterSet(
      { designSystemId: "ds", releaseId: "r", tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS) },
      PLAIN_BASE_TOKENS,
    );
    expect(() => resolveFrameworkAdapter(set, "web-react")).toThrow(/framework target/u);
  });

  it("NEGATIVE CONTROL — a Bevy projection without a native validator is infrastructure-inconclusive, never passed", async () => {
    const adapter = buildBevyAdapter(PLAIN_BASE_TOKENS);
    const profile = { target: adapter.target, capabilities: [] };
    const plain = await adapter.bootstrapPlainSystem(profile);
    const materialized = await adapter.materialize([], plain);
    const scenarios = await adapter.renderScenarioMatrix(materialized, profile);
    expect(scenarios.length).toBeGreaterThan(0);
    const digest = digestOf("artifact-1");
    const receipt = await recordFrameworkConformanceRun(adapter, {
      artifactDigest: digest,
      adapterVersion: "tanren.bevy.v1",
      requiredCapabilities: ["tokens", "catalog", "components", "bevy-ui", "bevy-asset", "cargo"],
    });
    expect(receipt.target).toBe("bevy");
    expect(receipt.artifactDigest).toBe(digest);
    expect(receipt.outcome).toBe("inconclusive_infrastructure");
    expect(receipt.criticalProofs.find((proof) => proof.kind === "build")?.passed).toBe(false);
    expect(receiptPasses(receipt)).toBe(false);
  });

  it("NEGATIVE CONTROL — a V2-required capability unsupported by the framework adapter records failed, never adapter-default pass", async () => {
    const adapter = buildBevyAdapter(PLAIN_BASE_TOKENS);
    const receipt = await recordFrameworkConformanceRun(adapter, {
      artifactDigest: digestOf("artifact-unsupported-framework"),
      adapterVersion: "tanren.bevy.v1",
      requiredCapabilities: ["tokens", "contract-only-capability"],
    });
    expect(receipt.requiredCapabilities).toEqual(["tokens", "contract-only-capability"]);
    expect(receipt.resolvedCapabilities).toContainEqual(
      expect.objectContaining({ capability: "contract-only-capability", supported: false }),
    );
    expect(receipt.outcome).toBe("failed");
    expect(receiptPasses(receipt)).toBe(false);
  });

  it("buildWebConformanceReceipt observes the real web static/build/export/matrix checks before passing", async () => {
    const web = buildWebAdapterForF2d("ds_web", "release_web", resolveDtcgTokens(PLAIN_BASE_TOKENS));
    const build = web.buildArtifact({
      artifactId: "artifact_web",
      contractDigest: digestOf("contract-web"),
      plainReleaseDigest: digestOf("plain-web"),
      polishedReleaseDigest: digestOf("polished-web"),
    });
    const receipt = await buildWebConformanceReceipt({
      web,
      artifactId: build.manifest.artifactId,
      artifactDigest: sha256Digest(build.manifestBytes),
      build,
      adapterVersion: "tanren.web-react.v1",
      requiredCapabilities: ["css-variables", "tailwind"],
    });
    expect(receipt.target).toBe("web-react");
    expect(receipt.scenarioMatrixDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(receiptPasses(receipt)).toBe(true);
  });

  it("NEGATIVE CONTROL — a capability required by the V2 contract but unsupported by web-react is not passed", async () => {
    const web = buildWebAdapterForF2d("ds_web", "release_web", resolveDtcgTokens(PLAIN_BASE_TOKENS));
    const build = web.buildArtifact({
      artifactId: "artifact_web_unsupported",
      contractDigest: digestOf("contract-web"),
      plainReleaseDigest: digestOf("plain-web"),
      polishedReleaseDigest: digestOf("polished-web"),
    });
    const receipt = await buildWebConformanceReceipt({
      web,
      artifactId: build.manifest.artifactId,
      artifactDigest: sha256Digest(build.manifestBytes),
      build,
      adapterVersion: "tanren.web-react.v1",
      requiredCapabilities: ["css-variables", "nonexistent-contract-capability"],
    });
    expect(receipt.outcome).toBe("failed");
    expect(receipt.resolvedCapabilities).toContainEqual(
      expect.objectContaining({ capability: "nonexistent-contract-capability", supported: false }),
    );
    expect(receiptPasses(receipt)).toBe(false);
  });

  it("buildWebAdapterForF2d constructs a web adapter against any tokens", () => {
    const adapter = buildWebAdapterForF2d("ds_1", "r_1", resolveDtcgTokens(PLAIN_BASE_TOKENS));
    expect(adapter.target).toBe("web-react");
  });

  it("the frozen receipt parses + preserves every required field", async () => {
    const web = buildWebAdapterForF2d("ds_web", "release_web", resolveDtcgTokens(PLAIN_BASE_TOKENS));
    const build = web.buildArtifact({
      artifactId: "artifact_web_receipt",
      contractDigest: digestOf("contract-web"),
      plainReleaseDigest: digestOf("plain-web"),
      polishedReleaseDigest: digestOf("polished-web"),
    });
    const receipt = await buildWebConformanceReceipt({
      web,
      artifactId: build.manifest.artifactId,
      artifactDigest: sha256Digest(build.manifestBytes),
      build,
      adapterVersion: "tanren.web-react.v1",
      requiredCapabilities: ["tokens", "catalog"],
    });
    const parsed = parseDesignAdapterConformanceReceipt(receipt);
    expect(parsed.requiredCapabilities).toEqual(["tokens", "catalog"]);
    expect(parsed.resolvedCapabilities.length).toBe(2);
    expect(parsed.criticalProofs.length).toBe(4);
    expect(parsed.positiveCases.length).toBe(2);
    expect(parsed.negativeControls.length).toBe(2);
  });
});
