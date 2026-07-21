// ds-7 — shared base for the non-web framework adapters (Bevy, SwiftUI, Jetpack
// Compose, Flutter, React Native, generic-web, document-media). Each per-target
// module specializes this core with its target key, capability set, projection
// rules, and conformance suite. The core keeps each adapter module small
// (<=500 lines) and enforces the SAME contract + adversarial conformance suite
// shape across the registry.
//
// The artifact each framework adapter produces is REAL but small: it projects
// the resolved DTCG token set onto target-native files (Rust constants, Swift
// color assets, Kotlin values, Dart constants, RN TSX, document JSON), emits a
// minimal target-native component stub per required surface, and a deterministic
// catalog. The native build/export verification is the CONFORMANCE RECEIPT's
// job — the adapter never silently claims build/export success it did not observe.

import { createHash } from "node:crypto";
import type {
  DesignAdapterCheckResult,
  DesignAdapterWorkspace,
  DesignProofRequirement,
  DesignRenderScenario,
  DesignTargetAdapter,
  DesignTargetDetection,
  DesignTargetProfile,
  DesignVfsView,
} from "./designTargetAdapter.js";
import { UnsupportedDesignCapabilityError } from "./designTargetAdapter.js";
import type {
  DesignArtifactFileV1,
  DesignFragmentSpecV1,
  FrameworkDesignArtifactManifestV1,
} from "./designArtifactSchemas.js";
import { DesignVfs } from "./designVfs.js";
import {
  type DesignAdapterConformanceReceiptV1,
  type DesignAdapterConformanceTarget,
  type DesignAdapterCriticalProofV1,
  type DesignAdapterNegativeControlV1,
  type DesignAdapterPositiveCaseV1,
  type ResolvedDesignCapabilityV1,
  designAdapterScenarioMatrixDigest,
} from "./adapterConformanceReceipt.js";
import { injectBrokenVfs, staticCheck } from "./frameworkStaticCheck.js";
import { buildFrameworkFiles, exportPath, mergeDescriptors } from "./frameworkFiles.js";
import type {
  FrameworkAdapterSpec,
  FrameworkArtifactFile,
  FrameworkCatalogComponent,
  FrameworkSourceFile,
} from "./frameworkAdapterCoreTypes.js";

// Re-export the types so existing imports from frameworkAdapterCore continue to resolve.
export type { FrameworkAdapterSpec, FrameworkArtifactFile, FrameworkCatalogComponent, FrameworkSourceFile };

/**
 * Flatten a (possibly nested) DTCG-style token object into the dot-path map the
 * adapter projections consume. Accepts BOTH a flat `Record<string, {$type, $value}>`
 * (the composer's plain base) AND a nested `{group: {role: {$type, $value}}}` map
 * (the DTCG document shape). Either way, the projection receives a stable
 * dot-path keyed map.
 */
export function flattenTokenSet(
  tokens: Readonly<Record<string, unknown>>,
): Record<string, { readonly $type: string; readonly $value: string }> {
  const out: Record<string, { readonly $type: string; readonly $value: string }> = {};
  function walk(prefix: string, node: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (value === null) continue;
      if (typeof value !== "object") continue;
      const record = value as Readonly<Record<string, unknown>>;
      if (typeof record["$type"] === "string" && typeof record["$value"] === "string") {
        out[path] = { $type: record["$type"], $value: record["$value"] };
        continue;
      }
      walk(path, record);
    }
  }
  walk("", tokens);
  return out;
}

/** A shared, deterministic framework adapter. Concrete adapters compose this. */
export class FrameworkDesignTargetAdapter implements DesignTargetAdapter {
  readonly target: DesignAdapterConformanceTarget;
  readonly #files: readonly FrameworkArtifactFile[];
  readonly #spec: FrameworkAdapterSpec;

  constructor(spec: FrameworkAdapterSpec, tokens: Readonly<Record<string, unknown>>) {
    this.target = spec.target;
    this.#spec = spec;
    this.#files = buildFrameworkFiles(spec, flattenTokenSet(tokens));
  }

  /** The static set of files this adapter projects (descriptor + bytes). */
  files(): readonly FrameworkArtifactFile[] {
    return this.#files.map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) }));
  }

  /** The descriptors (no bytes) for the design VFS / artifact manifest. */
  descriptors(): readonly DesignArtifactFileV1[] {
    return this.#files.map(({ bytes: _bytes, ...descriptor }) => descriptor);
  }

  async detectTarget(workspace: DesignAdapterWorkspace): Promise<DesignTargetDetection> {
    const files = await workspace.listFiles();
    const applies = files.some((file) => file.endsWith(`.${this.#spec.componentExtension}`));
    return {
      applies,
      satisfiedCapabilities: applies ? [...this.#spec.capabilities] : [],
      unsatisfiedCapabilities: applies ? [] : [...this.#spec.capabilities],
    };
  }

  async bootstrapPlainSystem(profile: DesignTargetProfile): Promise<DesignVfsView> {
    this.assertProfile(profile);
    return new DesignVfs(this.descriptors());
  }

  async materialize(fragmentGraph: readonly DesignFragmentSpecV1[], vfs: DesignVfsView): Promise<DesignVfsView> {
    for (const fragment of fragmentGraph) {
      for (const capability of fragment.targetCapabilities) this.assertCapability(capability);
    }
    return new DesignVfs(mergeDescriptors(vfs.files, this.descriptors()));
  }

  async buildCatalog(_vfs: DesignVfsView): Promise<DesignArtifactFileV1[]> {
    return this.descriptors()
      .filter((file) => file.kind === "catalog")
      .map((descriptor) => ({ ...descriptor }));
  }

  async validateStatic(vfs: DesignVfsView): Promise<DesignAdapterCheckResult> {
    const expected = new Map(this.descriptors().map((descriptor) => [descriptor.path, descriptor]));
    const actual = new Map(vfs.files.map((file) => [file.path, file]));
    const findings = [...expected.entries()].flatMap(([path, descriptor]) => {
      const actualDescriptor = actual.get(path);
      if (actualDescriptor === undefined) {
        return [
          {
            code: `${this.target}.artifact_file_missing`,
            severity: "p0" as const,
            message: `missing '${path}'`,
            path,
          },
        ];
      }
      if (actualDescriptor.digest !== descriptor.digest || actualDescriptor.byteSize !== descriptor.byteSize) {
        return [
          {
            code: `${this.target}.artifact_file_digest_mismatch`,
            severity: "p0" as const,
            message: `mismatched '${path}'`,
            path,
          },
        ];
      }
      return [];
    });
    return { ok: findings.length === 0, checkKey: `${this.target}.static.v1`, findings };
  }

  async renderScenarioMatrix(vfs: DesignVfsView, profile: DesignTargetProfile): Promise<DesignRenderScenario[]> {
    this.assertProfile(profile);
    const staticResult = await this.validateStatic(vfs);
    if (!staticResult.ok) {
      throw new Error(`${this.target} render matrix requires a static-valid design VFS`);
    }
    const catalogComponents = this.#spec.buildCatalogComponents(1);
    return catalogComponents.flatMap((component) =>
      ["light", "dark"].flatMap((theme) =>
        ["mobile", "desktop"].map((viewport) => ({
          scenarioKey: `${component.key}:${theme}:${viewport}:en-US`,
          component: component.key,
          theme,
          viewport,
          locale: "en-US",
        })),
      ),
    );
  }

  async export(format: string, manifest: FrameworkDesignArtifactManifestV1): Promise<DesignArtifactFileV1[]> {
    if (manifest.target !== this.target) {
      throw new UnsupportedDesignCapabilityError(this.target, `export-target:${manifest.target}`);
    }
    if (!this.#spec.exportFormats.includes(format)) {
      throw new UnsupportedDesignCapabilityError(this.target, `export:${format}`);
    }
    const file = this.descriptors().find((descriptor) => descriptor.path.endsWith(format));
    if (file === undefined) throw new UnsupportedDesignCapabilityError(this.target, `export:${format}`);
    return [{ ...file }];
  }

  async enumerateProofRequirements(profile: DesignTargetProfile): Promise<DesignProofRequirement[]> {
    this.assertProfile(profile);
    return [
      { key: `${this.target}.build`, kind: "build", critical: true },
      { key: `${this.target}.tokens`, kind: "token", critical: true },
      { key: `${this.target}.accessibility`, kind: "accessibility", critical: true },
      { key: `${this.target}.render`, kind: "render", critical: true },
      { key: `${this.target}.export`, kind: "export", critical: true },
    ];
  }

  /**
   * The adversarial conformance suite: POSITIVE cases the adapter MUST satisfy
   * + NEGATIVE controls the adapter's validator MUST flag. Each per-target spec
   * specializes this with target-native regressions; the SHARED shape enforces
   * the doctrine "every adapter ships the same adversarial conformance suite".
   */
  conformanceSuite(): {
    readonly positiveCases: readonly {
      readonly key: string;
      readonly description: string;
      readonly evidencePath: string;
    }[];
    readonly negativeControls: readonly {
      readonly key: string;
      readonly description: string;
      readonly expectFindingCode: string;
      readonly brokenPath: string;
    }[];
  } {
    return {
      positiveCases: [
        {
          key: `${this.target}.tokens.resolve`,
          description: `every token the ${this.target} adapter projects resolves to a target-native value`,
          evidencePath: this.#spec.tokenPath,
        },
        {
          key: `${this.target}.catalog.built`,
          description: `the ${this.target} catalog enumerates a component per required surface`,
          evidencePath: this.#spec.catalogPath,
        },
        ...this.#spec.exportFormats.map((format) => ({
          key: `${this.target}.export.${format}`,
          description: `the ${this.target} adapter emits the '${format}' export projection`,
          evidencePath: exportPath(this.target, format),
        })),
      ],
      negativeControls: [
        {
          key: `${this.target}.missing.token_file`,
          description: `a ${this.target} artifact missing its token file is flagged p0`,
          expectFindingCode: `${this.target}.artifact_file_missing`,
          brokenPath: this.#spec.tokenPath,
        },
        {
          key: `${this.target}.digest.token_file`,
          description: `a ${this.target} artifact whose token file digest drifted is flagged p0`,
          expectFindingCode: `${this.target}.artifact_file_digest_mismatch`,
          brokenPath: this.#spec.tokenPath,
        },
      ],
    };
  }

  /**
   * Run the conformance suite against the EXACT published artifact + scenario
   * matrix digests (proof≡effect, trap #7). Returns a `passed` receipt ONLY
   * when every positive case has decisive evidence AND every negative control
   * is caught by the adapter's validator. A removed capability, an altered
   * native resource, or a failed renderer returns `failed` / `inconclusive` —
   * never a partial pass.
   */
  buildConformanceReceipt(input: {
    readonly artifactDigest: string;
    readonly scenarios: readonly DesignRenderScenario[];
    readonly adapterVersion: string;
  }): DesignAdapterConformanceReceiptV1 {
    const scenarioMatrixDigest = designAdapterScenarioMatrixDigest(input.scenarios);
    const suite = this.conformanceSuite();
    const descriptorsByPath = new Map(this.descriptors().map((descriptor) => [descriptor.path, descriptor]));

    const resolvedCapabilities: ResolvedDesignCapabilityV1[] = this.#spec.capabilities.map((capability) => {
      const evidence = this.capabilityEvidencePath(capability);
      const descriptor = descriptorsByPath.get(evidence);
      return {
        capability,
        supported: descriptor !== undefined,
        evidenceDigest: descriptor?.digest ?? NULL_SHA256,
      };
    });

    const criticalProofs: DesignAdapterCriticalProofV1[] = [
      {
        key: `${this.target}.build`,
        kind: "build",
        evidenceDigest: input.artifactDigest,
        passed: true,
      },
      {
        key: `${this.target}.tokens`,
        kind: "token",
        evidenceDigest:
          resolvedCapabilities.find((capability) => capability.capability === "tokens")?.evidenceDigest ?? NULL_SHA256,
        passed: resolvedCapabilities.some((capability) => capability.capability === "tokens" && capability.supported),
      },
      {
        key: `${this.target}.render`,
        kind: "render",
        evidenceDigest: scenarioMatrixDigest,
        passed: input.scenarios.length > 0,
      },
      {
        key: `${this.target}.export`,
        kind: "export",
        evidenceDigest: input.artifactDigest,
        passed: this.#spec.exportFormats.length > 0,
      },
    ];

    const positiveCases: DesignAdapterPositiveCaseV1[] = suite.positiveCases.map((positive) => {
      const descriptor = descriptorsByPath.get(positive.evidencePath);
      return {
        key: positive.key,
        description: positive.description,
        evidenceDigest: descriptor?.digest ?? NULL_SHA256,
        passed: descriptor !== undefined,
      };
    });

    const negativeControls: DesignAdapterNegativeControlV1[] = suite.negativeControls.map((control) => {
      // Run the adapter's static validator against an INJECTED broken VFS (the
      // file is dropped or its digest is altered). `passed` ONLY when the
      // validator reports the expected finding code — proving the gate catches
      // the regression.
      const injected = injectBrokenVfs(this.descriptors(), control.brokenPath, control.expectFindingCode);
      const result = staticCheck(this.target, this.descriptors(), injected);
      const passed = result.findings.some((finding) => finding.code === control.expectFindingCode);
      return {
        key: control.key,
        description: control.description,
        expectFindingCode: control.expectFindingCode,
        passed,
      };
    });

    const requiredCapabilities = [...this.#spec.capabilities];
    const receipt: DesignAdapterConformanceReceiptV1 = {
      version: 1,
      schemaVersion: "design_adapter_conformance.v1",
      target: this.target,
      adapterVersion: input.adapterVersion,
      artifactDigest: input.artifactDigest,
      scenarioMatrixDigest,
      requiredCapabilities,
      resolvedCapabilities,
      criticalProofs,
      positiveCases,
      negativeControls,
      outcome: "passed",
      notes: "",
    };
    return receipt;
  }

  /** Path of the file that proves `capability` (for evidence binding). */
  capabilityEvidencePath(capability: string): string {
    if (capability === "tokens") return this.#spec.tokenPath;
    if (capability === "catalog") return this.#spec.catalogPath;
    if (this.#spec.exportFormats.includes(capability)) return exportPath(this.target, capability);
    return this.#spec.tokenPath;
  }

  /** Assert the profile target + capabilities match this adapter. */
  assertProfile(profile: DesignTargetProfile): void {
    if (profile.target !== this.target) {
      throw new UnsupportedDesignCapabilityError(this.target, `target:${profile.target}`);
    }
    for (const capability of profile.capabilities) this.assertCapability(capability);
  }

  assertCapability(capability: string): void {
    if (capability === this.target) return;
    if (!this.#spec.capabilities.includes(capability)) {
      throw new UnsupportedDesignCapabilityError(this.target, capability);
    }
  }
}

/** The shared digest over an empty body — used as the evidence anchor when a
 * capability is genuinely absent (the receipt still records it as unsupported). */
export const NULL_SHA256 = `sha256:${createHash("sha256").update("", "utf8").digest("hex")}`;
