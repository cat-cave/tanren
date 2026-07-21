// ds-2 — React/shadcn/Radix/Tailwind implementation of DesignTargetAdapter.

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
import {
  DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE,
  type DesignArtifactFileV1,
  type DesignFragmentSpecV1,
  type FrameworkDesignArtifactManifestV1,
  type FrameworkDesignArtifactManifestV1 as ArtifactManifest,
  parseDesignArtifactManifest,
} from "./designArtifactSchemas.js";
import type { DtcgResolution } from "./dtcgResolver.js";
import { DesignVfs } from "./designVfs.js";
import { projectWebCatalog, type WebComponentCatalog } from "./webCatalog.js";
import { isWebExportFormat, projectWebExports, type WebExportProjection } from "./webExports.js";
import { descriptorOf, materializeWebFile, type WebArtifactFile, type WebArtifactSourceFile } from "./webFiles.js";
import { projectWebTokens, type WebTokenProjection } from "./webTokens.js";
import type { WebDesignWriterContext } from "./webWriterContext.js";
import {
  persistWebDesignArtifact,
  type PersistedWebArtifact,
  type WebArtifactPublishContext,
} from "./webArtifactPersistence.js";

export const WEB_DESIGN_TARGET = "web-react" as const;

const WEB_CAPABILITIES = [
  "css-variables",
  "tailwind",
  "shadcn",
  "radix",
  "catalog",
  "storybook",
  "exports",
  "dtcg",
] as const;

export interface WebDesignSystemInput {
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly tokens: DtcgResolution;
}

export interface WebArtifactBuildInput {
  readonly artifactId: string;
  readonly contractDigest: string;
  readonly plainReleaseDigest: string;
  readonly polishedReleaseDigest: string;
  readonly fragmentLineage?: readonly string[];
}

export interface WebArtifactBuildResult {
  readonly manifest: ArtifactManifest;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly WebArtifactFile[];
  readonly catalog: WebComponentCatalog;
  readonly writerContext: WebDesignWriterContext;
  readonly exports: readonly WebExportProjection[];
}

/** The exact build object whose bytes the publish path persisted to CAS. */
export interface PublishedWebArtifact extends PersistedWebArtifact {
  readonly build: WebArtifactBuildResult;
}

/**
 * A deterministic web projection. The constructor receives ds-1's already
 * resolved DTCG token set; every method below implements the ds-0 adapter seam.
 */
export class WebDesignTargetAdapter implements DesignTargetAdapter {
  readonly target = WEB_DESIGN_TARGET;
  readonly #tokenProjection: WebTokenProjection;
  readonly #catalog: WebComponentCatalog;
  readonly #exports: readonly WebExportProjection[];
  readonly #files: readonly WebArtifactFile[];

  constructor(private readonly designSystem: WebDesignSystemInput) {
    this.#tokenProjection = projectWebTokens(designSystem.tokens);
    const catalog = projectWebCatalog(this.#tokenProjection.tokens);
    this.#catalog = catalog.catalog;
    this.#exports = projectWebExports(this.#tokenProjection, catalog.catalog);
    this.#files = materializeSources([
      manifestMetadataSource(),
      tokenSource("tokens/design.tokens.json", "tokens", this.#tokenProjection.dtcgExport),
      tokenSource("tokens/resolver.json", "resolver", this.#tokenProjection.resolverExport),
      { path: "styles/tokens.css", kind: "export", mediaType: "text/css", source: this.#tokenProjection.css },
      {
        path: "tailwind.config.ts",
        kind: "export",
        mediaType: "text/plain",
        source: this.#tokenProjection.tailwindConfig,
      },
      ...catalog.files,
      ...this.#exports.map((projection) => projection.file),
    ]);
  }

  async detectTarget(workspace: DesignAdapterWorkspace): Promise<DesignTargetDetection> {
    const files = await workspace.listFiles();
    const hasPackage = files.includes("package.json");
    const hasReactSource = files.some((file) => /(^|\/)src\/.*\.tsx$/u.test(file));
    const applies = hasPackage && hasReactSource;
    return {
      applies,
      satisfiedCapabilities: applies ? [...WEB_CAPABILITIES] : [],
      unsatisfiedCapabilities: applies ? [] : [...WEB_CAPABILITIES],
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
    return this.#files.filter((file) => file.kind === "catalog").map((file) => descriptorOf(file));
  }

  async validateStatic(vfs: DesignVfsView): Promise<DesignAdapterCheckResult> {
    const expected = new Map(this.descriptors().map((file) => [file.path, file]));
    const actual = new Map(vfs.files.map((file) => [file.path, file]));
    const findings = [...expected.entries()].flatMap(([path, file]) => {
      const actualFile = actual.get(path);
      if (actualFile === undefined) {
        return [{ code: "web.artifact_file_missing", severity: "p0" as const, message: `missing '${path}'`, path }];
      }
      if (actualFile.digest !== file.digest || actualFile.byteSize !== file.byteSize) {
        return [
          { code: "web.artifact_file_digest_mismatch", severity: "p0" as const, message: `mismatched '${path}'`, path },
        ];
      }
      return [];
    });
    return { ok: findings.length === 0, checkKey: "web-react.static.v1", findings };
  }

  async renderScenarioMatrix(vfs: DesignVfsView, profile: DesignTargetProfile): Promise<DesignRenderScenario[]> {
    this.assertProfile(profile);
    const staticResult = await this.validateStatic(vfs);
    if (!staticResult.ok) throw new Error("web render matrix requires a static-valid design VFS");
    return this.#catalog.components.flatMap((component) =>
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
    if (manifest.target !== this.target)
      throw new UnsupportedDesignCapabilityError(this.target, `export-target:${manifest.target}`);
    if (!isWebExportFormat(format)) throw new UnsupportedDesignCapabilityError(this.target, `export:${format}`);
    const output = this.#exports.find((projection) => projection.id === format);
    if (output === undefined) throw new UnsupportedDesignCapabilityError(this.target, `export:${format}`);
    return [descriptorOf(materializeWebFile(output.file))];
  }

  async enumerateProofRequirements(profile: DesignTargetProfile): Promise<DesignProofRequirement[]> {
    this.assertProfile(profile);
    return [
      { key: "web.build", kind: "build", critical: true },
      { key: "web.tokens", kind: "token", critical: true },
      { key: "web.accessibility", kind: "accessibility", critical: true },
      { key: "web.interaction", kind: "interaction", critical: true },
      { key: "web.render", kind: "render", critical: true },
      { key: "web.exports", kind: "export", critical: true },
    ];
  }

  /** Build the content-addressed framework artifact ready for CAS + table persistence. */
  buildArtifact(input: WebArtifactBuildInput): WebArtifactBuildResult {
    const files = this.files();
    const manifest = parseDesignArtifactManifest({
      manifestVersion: 1,
      artifactId: input.artifactId,
      releaseId: this.designSystem.releaseId,
      target: this.target,
      contractDigest: input.contractDigest,
      plainReleaseDigest: input.plainReleaseDigest,
      polishedReleaseDigest: input.polishedReleaseDigest,
      files: files.map((file) => descriptorOf(file)),
      fragmentLineage: [...(input.fragmentLineage ?? [])],
      exports: this.#exports.map((projection) => projection.id),
      proofDigests: {},
    });
    return {
      manifest,
      manifestBytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
      files,
      catalog: this.#catalog,
      writerContext: {
        designSystemId: this.designSystem.designSystemId,
        releaseId: this.designSystem.releaseId,
        artifactId: input.artifactId,
        catalog: this.#catalog,
        tokens: this.#tokenProjection.tokens,
      },
      exports: this.#exports,
    };
  }

  /** Persist the built artifact through ds-1's CAS store and ds-0's org-scoped tables. */
  async publish(input: WebArtifactBuildInput & WebArtifactPublishContext): Promise<PublishedWebArtifact> {
    const { artifactId, contractDigest, plainReleaseDigest, polishedReleaseDigest, fragmentLineage, ...context } =
      input;
    const build = this.buildArtifact({
      artifactId,
      contractDigest,
      plainReleaseDigest,
      polishedReleaseDigest,
      fragmentLineage,
    });
    const persisted = await persistWebDesignArtifact({
      ...context,
      designSystemId: this.designSystem.designSystemId,
      artifact: build,
    });
    return { ...persisted, build };
  }

  private descriptors(): DesignArtifactFileV1[] {
    return this.#files.map(descriptorOf);
  }

  private files(): WebArtifactFile[] {
    return this.#files.map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) }));
  }

  private assertProfile(profile: DesignTargetProfile): void {
    if (profile.target !== this.target)
      throw new UnsupportedDesignCapabilityError(this.target, `target:${profile.target}`);
    for (const capability of profile.capabilities) this.assertCapability(capability);
  }

  private assertCapability(capability: string): void {
    if (capability === this.target) return;
    if (!(WEB_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new UnsupportedDesignCapabilityError(this.target, capability);
    }
  }
}

function manifestMetadataSource(): WebArtifactSourceFile {
  return {
    path: "manifest/web-adapter.json",
    kind: "manifest",
    mediaType: "application/json",
    source: `${JSON.stringify({ schemaVersion: 1, target: WEB_DESIGN_TARGET, mediaType: DESIGN_ARTIFACT_MANIFEST_MEDIA_TYPE })}\n`,
  };
}

function tokenSource(path: string, kind: "tokens" | "resolver", source: string): WebArtifactSourceFile {
  return { path, kind, mediaType: "application/json", source };
}

function materializeSources(sources: readonly WebArtifactSourceFile[]): WebArtifactFile[] {
  const paths = new Set<string>();
  return [...sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => {
      if (paths.has(source.path)) throw new Error(`web artifact has duplicate generated path '${source.path}'`);
      paths.add(source.path);
      return materializeWebFile(source);
    });
}

function mergeDescriptors(
  existing: readonly DesignArtifactFileV1[],
  generated: readonly DesignArtifactFileV1[],
): DesignArtifactFileV1[] {
  const byPath = new Map(existing.map((file) => [file.path, file]));
  for (const file of generated) {
    const prior = byPath.get(file.path);
    if (prior !== undefined && prior.digest !== file.digest) {
      throw new Error(`web materialization conflicts with existing '${file.path}'`);
    }
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}
