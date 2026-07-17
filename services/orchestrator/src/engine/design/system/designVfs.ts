// ds-1 — constrained, deterministic virtual files for a design artifact.

import {
  DesignArtifactFileV1,
  type DesignArtifactFileKind,
  type DesignArtifactFileV1 as DesignArtifactFile,
} from "./designArtifactSchemas.js";
import type { DesignVfsOperation, DesignVfsView } from "./designTargetAdapter.js";
import { checkArtifactPath } from "./designFoundationValidator.js";

export type DesignVfsFileInput = Omit<DesignArtifactFile, "executable"> & { readonly executable?: boolean };

export class DesignVfsPathError extends Error {
  constructor(
    readonly path: string,
    readonly issue: string,
  ) {
    super(`design VFS path '${path}' is invalid: ${issue}`);
    this.name = "DesignVfsPathError";
  }
}

export class DesignVfsCollisionError extends Error {
  constructor(readonly path: string) {
    super(`design VFS already contains '${path}'`);
    this.name = "DesignVfsCollisionError";
  }
}

export class DesignVfsOperationError extends Error {
  constructor(
    readonly operation: DesignVfsOperation,
    readonly kind: DesignArtifactFileKind,
  ) {
    super(`design VFS operation '${operation}' cannot add a '${kind}' file`);
    this.name = "DesignVfsOperationError";
  }
}

export class DesignVfsMissingFileError extends Error {
  constructor(readonly path: string) {
    super(`design VFS file '${path}' is not present`);
    this.name = "DesignVfsMissingFileError";
  }
}

const OPERATION_KINDS: Readonly<Record<DesignVfsOperation, readonly DesignArtifactFileKind[]>> = {
  addTokenSet: ["tokens"],
  addMode: ["tokens"],
  addAlias: ["tokens"],
  addComponent: ["component-source", "component-contract"],
  addScenario: ["fixture"],
  addAsset: ["asset"],
  addExporter: ["export"],
  addCatalogRoute: ["catalog"],
};

/**
 * Mutable only through named design operations. Its public `files`/`fileAt`
 * surface satisfies the adapter's read-only DesignVfsView contract.
 */
export class DesignVfs implements DesignVfsView {
  readonly #files = new Map<string, DesignArtifactFile>();
  readonly #normalizedPaths = new Set<string>();

  constructor(initialFiles: readonly DesignArtifactFile[] = []) {
    for (const file of initialFiles) this.insertInitial(file);
  }

  get files(): readonly DesignArtifactFile[] {
    return [...this.#files.values()].sort(byPath).map((file) => copyFile(file));
  }

  fileAt(path: string): DesignArtifactFile | undefined {
    assertSafePath(path);
    const file = this.#files.get(path);
    return file === undefined ? undefined : copyFile(file);
  }

  read(path: string): DesignArtifactFile {
    const file = this.fileAt(path);
    if (file === undefined) throw new DesignVfsMissingFileError(path);
    return file;
  }

  addTokenSet(file: DesignVfsFileInput): void {
    this.add("addTokenSet", file);
  }

  addMode(file: DesignVfsFileInput): void {
    this.add("addMode", file);
  }

  addAlias(file: DesignVfsFileInput): void {
    this.add("addAlias", file);
  }

  addComponent(file: DesignVfsFileInput): void {
    this.add("addComponent", file);
  }

  addScenario(file: DesignVfsFileInput): void {
    this.add("addScenario", file);
  }

  addAsset(file: DesignVfsFileInput): void {
    this.add("addAsset", file);
  }

  addExporter(file: DesignVfsFileInput): void {
    this.add("addExporter", file);
  }

  addCatalogRoute(file: DesignVfsFileInput): void {
    this.add("addCatalogRoute", file);
  }

  private add(operation: DesignVfsOperation, input: DesignVfsFileInput): void {
    const file = DesignArtifactFileV1.parse(input);
    assertSafePath(file.path);
    if (!OPERATION_KINDS[operation].includes(file.kind)) throw new DesignVfsOperationError(operation, file.kind);
    this.insert(file);
  }

  private insertInitial(file: DesignArtifactFile): void {
    DesignArtifactFileV1.parse(file);
    assertSafePath(file.path);
    this.insert(file);
  }

  private insert(file: DesignArtifactFile): void {
    const normalized = file.path.toLowerCase();
    if (this.#normalizedPaths.has(normalized)) throw new DesignVfsCollisionError(file.path);
    this.#files.set(file.path, copyFile(file));
    this.#normalizedPaths.add(normalized);
  }
}

function assertSafePath(path: string): void {
  const finding = checkArtifactPath(path)[0];
  if (finding !== undefined) throw new DesignVfsPathError(path, finding.message);
}

function copyFile(file: DesignArtifactFile): DesignArtifactFile {
  return { ...file };
}

function byPath(left: DesignArtifactFile, right: DesignArtifactFile): number {
  return left.path.localeCompare(right.path);
}
