// ds-2 — deterministic byte/file helpers shared by the web adapter projections.

import { sha256Digest } from "./artifactStore.js";
import type { DesignArtifactFileKind, DesignArtifactFileV1 } from "./designArtifactSchemas.js";

export interface WebArtifactSourceFile {
  readonly path: string;
  readonly kind: DesignArtifactFileKind;
  readonly mediaType: string;
  readonly source: string;
  readonly executable?: boolean;
}

export interface WebArtifactFile extends DesignArtifactFileV1 {
  readonly bytes: Uint8Array;
}

export function materializeWebFile(source: WebArtifactSourceFile): WebArtifactFile {
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
}

export function descriptorOf(file: WebArtifactFile): DesignArtifactFileV1 {
  const { bytes: _bytes, ...descriptor } = file;
  return descriptor;
}
