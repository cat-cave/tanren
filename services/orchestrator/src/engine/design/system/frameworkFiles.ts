// ds-7 — framework adapter file-build helpers extracted from
// `frameworkAdapterCore.ts` to keep that file under the 500-line cap.

import type { DesignArtifactFileV1 } from "./designArtifactSchemas.js";
import { sha256Digest } from "./artifactStore.js";
import type { FrameworkAdapterSpec, FrameworkArtifactFile, FrameworkSourceFile } from "./frameworkAdapterCoreTypes.js";

/** Build the full file set (manifest + tokens + components + catalog + exports). */
export function buildFrameworkFiles(
  spec: FrameworkAdapterSpec,
  tokens: Readonly<Record<string, { readonly $type: string; readonly $value: string }>>,
): readonly FrameworkArtifactFile[] {
  const sources: FrameworkSourceFile[] = [
    {
      path: `manifest/${spec.target}-adapter.json`,
      kind: "manifest",
      mediaType: "application/json",
      source: `${JSON.stringify({ schemaVersion: 1, target: spec.target })}\n`,
    },
    {
      path: spec.tokenPath,
      kind: "tokens",
      mediaType: spec.tokenMediaType,
      source: spec.projectTokens(tokens),
    },
    ...spec.buildCatalogComponents(1).map<FrameworkSourceFile>((component) => ({
      path: component.sourcePath,
      kind: "component-source",
      mediaType: "text/plain",
      source: spec.componentHeader(component.key),
    })),
    {
      path: spec.catalogPath,
      kind: "catalog",
      mediaType: "application/json",
      source: `${JSON.stringify(
        {
          schemaVersion: 1,
          target: spec.target,
          components: spec.buildCatalogComponents(1).map((component) => ({
            key: component.key,
            primitive: component.primitive,
            sourcePath: component.sourcePath,
          })),
        },
        null,
        2,
      )}\n`,
    },
    ...spec.exportFormats.map<FrameworkSourceFile>((format) => ({
      path: exportPath(spec.target, format),
      kind: "export",
      mediaType: "text/plain",
      source: `# ${spec.target} export projection '${format}'\n`,
    })),
  ];
  return materializeFrameworkSources(sources);
}

/** Materialize source strings into bytes + content addresses. */
export function materializeFrameworkSources(sources: readonly FrameworkSourceFile[]): FrameworkArtifactFile[] {
  const paths = new Set<string>();
  return [...sources]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => {
      if (paths.has(source.path)) {
        throw new Error(`framework artifact has duplicate generated path '${source.path}'`);
      }
      paths.add(source.path);
      const bytes = new TextEncoder().encode(source.source);
      return {
        path: source.path,
        kind: source.kind,
        mediaType: source.mediaType,
        digest: sha256Digest(bytes),
        byteSize: bytes.byteLength,
        executable: source.executable ?? false,
        bytes,
      };
    });
}

/** Merge generated descriptors into an existing set, failing LOUDLY on a digest conflict. */
export function mergeDescriptors(
  existing: readonly DesignArtifactFileV1[],
  generated: readonly DesignArtifactFileV1[],
): DesignArtifactFileV1[] {
  const byPath = new Map(existing.map((file) => [file.path, file]));
  for (const file of generated) {
    const prior = byPath.get(file.path);
    if (prior !== undefined && prior.digest !== file.digest) {
      throw new Error(`${generated[0]?.kind ?? "framework"} materialization conflicts with existing '${file.path}'`);
    }
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

/** Path of the per-target export projection file. */
export function exportPath(target: string, format: string): string {
  return `exports/${target}-${format}.txt`;
}
