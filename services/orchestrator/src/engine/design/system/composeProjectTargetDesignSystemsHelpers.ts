// ds-7 — helpers extracted from `composeProjectTargetDesignSystems` to keep the
// composer under the 500-line cap. Each helper is single-purpose; together
// they form the per-target publish + conformance-record flow.

import { createHash, randomUUID } from "node:crypto";
import type { DesignAdapterConformanceReceiptV1, ResolvedDesignCapabilityV1 } from "./adapterConformanceReceipt.js";
import { WEB_DESIGN_TARGET, WebDesignTargetAdapter } from "./webAdapter.js";
import type { WebArtifactBuildResult } from "./webAdapter.js";
import { WEB_EXPORT_FORMATS } from "./webExports.js";
import { sha256Digest } from "./artifactStore.js";
import type { DtcgResolution } from "./dtcgResolver.js";
import type { FrameworkDesignTargetAdapter } from "./frameworkAdapterCore.js";
import type { FrameworkArtifactBuildResult } from "./frameworkArtifactPersistence.js";
import type { DesignTargetAdapterSet } from "./designTargetRegistry.js";
import { DesignVfs } from "./designVfs.js";

const NULL_DIGEST = `sha256:${"0".repeat(64)}`;

/** A `sha256:<hex>` content address over a stable JSON body (digest anchors). */
export function digestOf(body: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
}

/** Encode the framework artifact's manifest as canonical JSON bytes for CAS put. */
export function encodeFrameworkManifest(artifact: FrameworkArtifactBuildResult): Uint8Array {
  const manifest = {
    manifestVersion: 1,
    artifactId: artifact.artifactId,
    releaseId: artifact.releaseId,
    target: artifact.target,
    contractDigest: artifact.contractDigest,
    plainReleaseDigest: artifact.plainReleaseDigest,
    polishedReleaseDigest: artifact.polishedReleaseDigest,
    files: artifact.files.map((file) => ({
      path: file.path,
      kind: file.kind,
      mediaType: file.mediaType,
      digest: file.digest,
      byteSize: file.byteSize,
      executable: file.executable,
    })),
    fragmentLineage: [...artifact.fragmentLineage],
    exports: [...artifact.exports],
    proofDigests: {},
  };
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** Build the framework artifact build-result from a target adapter + lineage. */
export function buildFrameworkArtifact(
  adapter: FrameworkDesignTargetAdapter,
  input: {
    readonly artifactId: string;
    readonly releaseId: string;
    readonly target: DesignAdapterConformanceReceiptV1["target"];
    readonly contractDigest: string;
    readonly plainReleaseDigest: string;
    readonly polishedReleaseDigest: string;
    readonly fragmentLineage: readonly string[];
  },
): FrameworkArtifactBuildResult {
  return {
    artifactId: input.artifactId,
    releaseId: input.releaseId,
    target: input.target,
    contractDigest: input.contractDigest,
    plainReleaseDigest: input.plainReleaseDigest,
    polishedReleaseDigest: input.polishedReleaseDigest,
    files: adapter.files(),
    exports: [],
    fragmentLineage: input.fragmentLineage,
  };
}

/** Resolve a framework adapter handle from the production set (per-target). */
export function resolveFrameworkAdapter(
  adapterSet: DesignTargetAdapterSet,
  target: DesignAdapterConformanceReceiptV1["target"],
): FrameworkDesignTargetAdapter {
  switch (target) {
    case "bevy":
      return adapterSet.bevy;
    case "swiftui":
      return adapterSet.swiftUi;
    case "jetpack-compose":
      return adapterSet.jetpackCompose;
    case "flutter":
      return adapterSet.flutter;
    case "react-native":
      return adapterSet.reactNative;
    case "generic-web":
      return adapterSet.genericWeb;
    case "document-media":
      return adapterSet.documentMedia;
    default:
      throw new Error(`framework adapter for '${target}' is not a framework target`);
  }
}

/** Build the framework conformance receipt over the EXACT artifact+matrix digest.
 * Enumerates the target's render-scenario matrix so the `render` critical proof
 * has POSITIVE evidence — never a vacuous pass over an empty scenario set. */
export async function recordFrameworkConformanceRun(
  adapter: FrameworkDesignTargetAdapter,
  input: {
    readonly artifactDigest: string;
    readonly adapterVersion: string;
    /** The V2 contract's required set — it must never be replaced with adapter defaults. */
    readonly requiredCapabilities: readonly string[];
  },
): Promise<DesignAdapterConformanceReceiptV1> {
  const resolvedCapabilities = await probeFrameworkCapabilities(adapter, input.requiredCapabilities);
  const supportedCapabilities = resolvedCapabilities
    .filter((capability) => capability.supported)
    .map((capability) => capability.capability);
  const profile = { target: adapter.target, capabilities: supportedCapabilities };
  const plain = await adapter.bootstrapPlainSystem(profile);
  const materialized = await adapter.materialize([], plain);
  const staticResult = await adapter.validateStatic(materialized);
  const scenarios = staticResult.ok ? await adapter.renderScenarioMatrix(materialized, profile) : [];
  return adapter.buildConformanceReceipt({
    artifactDigest: input.artifactDigest,
    scenarios,
    adapterVersion: input.adapterVersion,
    requiredCapabilities: input.requiredCapabilities,
    resolvedCapabilities,
    staticResult,
  });
}

/**
 * Run the web adapter's REAL checks over the same built artifact that was
 * persisted to CAS, then construct its receipt from those observed effects.
 * This is intentionally not a convenience constructor: no proof may be green
 * merely because the adapter advertises a capability or has a descriptor.
 */
export async function buildWebConformanceReceipt(input: {
  readonly web: WebDesignTargetAdapter;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly build: WebArtifactBuildResult;
  readonly adapterVersion: string;
  readonly requiredCapabilities: readonly string[];
}): Promise<DesignAdapterConformanceReceiptV1> {
  const resolvedCapabilities = await probeWebCapabilities(input.web, input.build, input.requiredCapabilities);
  try {
    const profile = { target: WEB_DESIGN_TARGET, capabilities: [] };
    const plain = await input.web.bootstrapPlainSystem(profile);
    const materialized = await input.web.materialize([], plain);
    const staticResult = await input.web.validateStatic(materialized);
    const catalog = staticResult.ok ? await input.web.buildCatalog(materialized) : [];
    const scenarios = staticResult.ok ? await input.web.renderScenarioMatrix(materialized, profile) : [];
    const scenarioMatrixDigest = digestOf([
      "tanren.design-adapter.scenario-matrix.v1",
      scenarios.map((scenario) => scenario.scenarioKey),
    ]);
    const exportChecks = await Promise.all(
      WEB_EXPORT_FORMATS.map(async (format) => {
        try {
          const exported = await input.web.export(format, input.build.manifest);
          const expected = input.build.files.find((file) => file.path === exported[0]?.path);
          return (
            exported.length === 1 &&
            expected !== undefined &&
            expected.digest === exported[0]?.digest &&
            input.build.manifest.exports.includes(format)
          );
        } catch {
          return false;
        }
      }),
    );
    const tokenFile = input.build.files.find((file) => file.path === "styles/tokens.css");
    const missingToken = await input.web.validateStatic(
      new DesignVfs(materialized.files.filter((file) => file.path !== tokenFile?.path)),
    );
    const driftedToken = await input.web.validateStatic(
      new DesignVfs(
        materialized.files.map((file) =>
          file.path === tokenFile?.path
            ? { ...file, digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
            : file,
        ),
      ),
    );
    const buildPassed =
      input.build.manifest.artifactId === input.artifactId &&
      input.build.manifest.target === WEB_DESIGN_TARGET &&
      sha256Digest(input.build.manifestBytes) === input.artifactDigest;
    const tokensPassed = staticResult.ok && tokenFile !== undefined;
    const renderPassed = staticResult.ok && scenarios.length > 0;
    const exportsPassed = exportChecks.every(Boolean);
    const positiveCases = [
      {
        key: "web-react.tokens.resolve",
        description: "the static validator accepted the generated CSS token projection",
        evidenceDigest: tokenFile?.digest ?? input.artifactDigest,
        passed: tokensPassed,
      },
      {
        key: "web-react.catalog.built",
        description: "the adapter built a non-empty catalog from the materialized VFS",
        evidenceDigest: catalog[0]?.digest ?? input.artifactDigest,
        passed: staticResult.ok && catalog.length > 0,
      },
    ];
    const negativeControls = [
      {
        key: "web-react.missing.token_file",
        description: "the real web static validator flags a removed token file",
        expectFindingCode: "web.artifact_file_missing",
        passed: missingToken.findings.some((finding) => finding.code === "web.artifact_file_missing"),
      },
      {
        key: "web-react.digest.token_file",
        description: "the real web static validator flags a drifted token digest",
        expectFindingCode: "web.artifact_file_digest_mismatch",
        passed: driftedToken.findings.some((finding) => finding.code === "web.artifact_file_digest_mismatch"),
      },
    ];
    const passed =
      resolvedCapabilities.every((capability) => capability.supported) &&
      buildPassed &&
      tokensPassed &&
      renderPassed &&
      exportsPassed &&
      positiveCases.every((positive) => positive.passed) &&
      negativeControls.every((control) => control.passed);
    return {
      version: 1,
      schemaVersion: "design_adapter_conformance.v1",
      target: WEB_DESIGN_TARGET,
      adapterVersion: input.adapterVersion,
      artifactDigest: input.artifactDigest,
      scenarioMatrixDigest,
      requiredCapabilities: [...input.requiredCapabilities],
      resolvedCapabilities,
      criticalProofs: [
        { key: "web-react.build", kind: "build", evidenceDigest: input.artifactDigest, passed: buildPassed },
        {
          key: "web-react.tokens",
          kind: "token",
          evidenceDigest: tokenFile?.digest ?? input.artifactDigest,
          passed: tokensPassed,
        },
        {
          key: "web-react.render",
          kind: "render",
          evidenceDigest: scenarioMatrixDigest,
          passed: renderPassed,
        },
        { key: "web-react.export", kind: "export", evidenceDigest: input.artifactDigest, passed: exportsPassed },
      ],
      positiveCases,
      negativeControls,
      outcome: passed ? "passed" : "failed",
      notes: passed ? "" : "one or more observed web adapter checks did not pass",
    };
  } catch {
    return inconclusiveWebReceipt(input, resolvedCapabilities);
  }
}

async function probeFrameworkCapabilities(
  adapter: FrameworkDesignTargetAdapter,
  requiredCapabilities: readonly string[],
): Promise<ResolvedDesignCapabilityV1[]> {
  return Promise.all(
    requiredCapabilities.map(async (capability) => {
      const evidence = adapter.descriptors().find((file) => file.path === adapter.capabilityEvidencePath(capability));
      try {
        const vfs = await adapter.bootstrapPlainSystem({ target: adapter.target, capabilities: [capability] });
        const staticResult = await adapter.validateStatic(vfs);
        return {
          capability,
          supported: staticResult.ok && evidence !== undefined,
          evidenceDigest: evidence?.digest ?? NULL_DIGEST,
        };
      } catch {
        return { capability, supported: false, evidenceDigest: evidence?.digest ?? NULL_DIGEST };
      }
    }),
  );
}

async function probeWebCapabilities(
  web: WebDesignTargetAdapter,
  build: WebArtifactBuildResult,
  requiredCapabilities: readonly string[],
): Promise<ResolvedDesignCapabilityV1[]> {
  return Promise.all(
    requiredCapabilities.map(async (capability) => {
      const evidence = webCapabilityEvidence(build, capability);
      try {
        const vfs = await web.bootstrapPlainSystem({ target: WEB_DESIGN_TARGET, capabilities: [capability] });
        const staticResult = await web.validateStatic(vfs);
        return {
          capability,
          supported: staticResult.ok && evidence !== undefined,
          evidenceDigest: evidence?.digest ?? NULL_DIGEST,
        };
      } catch {
        return { capability, supported: false, evidenceDigest: evidence?.digest ?? NULL_DIGEST };
      }
    }),
  );
}

function webCapabilityEvidence(build: WebArtifactBuildResult, capability: string) {
  const paths: Record<string, string> = {
    "css-variables": "styles/tokens.css",
    tailwind: "tailwind.config.ts",
    shadcn: "components.json",
    radix: "components/ui/button.tsx",
    catalog: "catalog/components.json",
    storybook: "catalog/components.stories.tsx",
    exports: "exports/tokens.css",
    dtcg: "tokens/design.tokens.json",
  };
  const path = paths[capability];
  return path === undefined ? undefined : build.files.find((file) => file.path === path);
}

function inconclusiveWebReceipt(
  input: {
    readonly artifactDigest: string;
    readonly adapterVersion: string;
    readonly requiredCapabilities: readonly string[];
  },
  resolvedCapabilities: readonly ResolvedDesignCapabilityV1[],
): DesignAdapterConformanceReceiptV1 {
  return {
    version: 1,
    schemaVersion: "design_adapter_conformance.v1",
    target: WEB_DESIGN_TARGET,
    adapterVersion: input.adapterVersion,
    artifactDigest: input.artifactDigest,
    scenarioMatrixDigest: digestOf([]),
    requiredCapabilities: [...input.requiredCapabilities],
    resolvedCapabilities: resolvedCapabilities.map((capability) => ({ ...capability })),
    criticalProofs: [
      { key: "web-react.build", kind: "build", evidenceDigest: input.artifactDigest, passed: false },
      { key: "web-react.tokens", kind: "token", evidenceDigest: input.artifactDigest, passed: false },
      { key: "web-react.render", kind: "render", evidenceDigest: input.artifactDigest, passed: false },
      { key: "web-react.export", kind: "export", evidenceDigest: input.artifactDigest, passed: false },
    ],
    positiveCases: [
      {
        key: "web-react.tokens.resolve",
        description: "web static validation did not complete",
        evidenceDigest: input.artifactDigest,
        passed: false,
      },
      {
        key: "web-react.catalog.built",
        description: "web catalog construction did not complete",
        evidenceDigest: input.artifactDigest,
        passed: false,
      },
    ],
    negativeControls: [
      {
        key: "web-react.missing.token_file",
        description: "web negative-control validation did not complete",
        expectFindingCode: "web.artifact_file_missing",
        passed: false,
      },
      {
        key: "web-react.digest.token_file",
        description: "web negative-control validation did not complete",
        expectFindingCode: "web.artifact_file_digest_mismatch",
        passed: false,
      },
    ],
    outcome: "inconclusive_infrastructure",
    notes: "web conformance runner could not complete its real validation path",
  };
}

/** A new id stamped with the target — keeps ids target-traceable in logs. */
export function newTargetArtifactId(target: string): string {
  return `design_${target}_artifact_${randomUUID()}`;
}

/** A new conformance-run id stamped with the target. */
export function newConformanceRunId(target: string): string {
  return `conformance_${target}_${randomUUID()}`;
}

/** Construct a web adapter for F2D validation (target-agnostic authoring). */
export function buildWebAdapterForF2d(
  designSystemId: string,
  releaseId: string,
  tokens: DtcgResolution,
): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({ designSystemId, releaseId, tokens });
}
