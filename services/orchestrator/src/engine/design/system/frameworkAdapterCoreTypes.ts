// ds-7 — shared TYPES for the framework adapter modules (extracted to avoid
// circular imports between `frameworkAdapterCore.ts` and `frameworkFiles.ts`).

import type { DesignArtifactFileV1 } from "./designArtifactSchemas.js";
import type { DesignAdapterConformanceTarget } from "./adapterConformanceReceipt.js";

/** A typed projection file a framework adapter emits (path + kind + source bytes). */
export interface FrameworkSourceFile {
  readonly path: string;
  readonly kind: DesignArtifactFileV1["kind"];
  readonly mediaType: string;
  readonly source: string;
  readonly executable?: boolean;
}

/** A materialized projection file (descriptor + bytes). */
export interface FrameworkArtifactFile {
  readonly path: string;
  readonly kind: DesignArtifactFileV1["kind"];
  readonly mediaType: string;
  readonly digest: string;
  readonly byteSize: number;
  readonly executable: boolean;
  readonly bytes: Uint8Array;
}

/** One target-native component the catalog emits. */
export interface FrameworkCatalogComponent {
  readonly key: string;
  readonly sourcePath: string;
  readonly primitive: string;
}

/** Specialization: per-target projection rules (re-exported for type parity). */
export interface FrameworkAdapterSpec {
  readonly target: DesignAdapterConformanceTarget;
  readonly capabilities: readonly string[];
  readonly componentExtension: string;
  readonly componentPrefix: string;
  readonly tokenPath: string;
  readonly tokenMediaType: string;
  projectTokens(tokens: Readonly<Record<string, { readonly $type: string; readonly $value: string }>>): string;
  readonly catalogPath: string;
  readonly exportFormats: readonly string[];
  buildCatalogComponents(surfaceCount: number): readonly FrameworkCatalogComponent[];
  componentHeader(key: string): string;
}
