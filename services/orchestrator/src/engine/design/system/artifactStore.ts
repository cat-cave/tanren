// ds-1 — sha256-addressed byte substrate for design artifacts.
//
// Postgres persists manifest metadata and this contract owns only bytes. The
// filesystem implementation is the deterministic local fake; production object
// stores can satisfy the same two-method contract without changing callers.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** The shared local design-artifact CAS root. Content-addressed (and can be rebuilt), so
 * an OS-temp root is a safe zero-config default. Both the greenfield composer
 * (which WRITES the bytes) and the ds-5 export route (which READS them) resolve
 * this single constant so an export streams the exact bytes the compose produced. */
export const DEFAULT_DESIGN_ARTIFACT_ROOT = join(tmpdir(), "tanren-design-artifacts");

export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<string>;
  get(digest: string): Promise<Uint8Array>;
}

export class ArtifactDigestFormatError extends Error {
  constructor(readonly digest: string) {
    super(`artifact digest '${digest}' must be sha256:<64-hex>`);
    this.name = "ArtifactDigestFormatError";
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(readonly digest: string) {
    super(`artifact '${digest}' is not present`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactDigestMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`artifact digest mismatch: expected '${expected}', got '${actual}'`);
    this.name = "ArtifactDigestMismatchError";
  }
}

/** Compute the canonical sha256 content address used by the artifact tables. */
export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Validate a digest before it is used as an object address. */
export function assertArtifactDigest(digest: string): void {
  if (!SHA256_DIGEST.test(digest)) throw new ArtifactDigestFormatError(digest);
}

/** Canonical, traversal-free object-store key derived entirely from the digest. */
export function artifactObjectStoreKey(digest: string): string {
  assertArtifactDigest(digest);
  const hex = digest.slice("sha256:".length);
  return `sha256/${hex.slice(0, 2)}/${hex}`;
}

/** Local content-addressed filesystem store for tests and development. */
export class FilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    const copy = new Uint8Array(bytes);
    const digest = sha256Digest(copy);
    const path = this.pathFor(digest);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, copy, { flag: "wx" });
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      await this.get(digest);
    }
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    assertArtifactDigest(digest);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathFor(digest));
    } catch (error: unknown) {
      if (isMissing(error)) throw new ArtifactNotFoundError(digest);
      throw error;
    }
    const actual = sha256Digest(bytes);
    if (actual !== digest) throw new ArtifactDigestMismatchError(digest, actual);
    return new Uint8Array(bytes);
  }

  /** Exposed for local diagnostics/tests; callers still address all bytes by digest. */
  pathFor(digest: string): string {
    return join(this.root, artifactObjectStoreKey(digest));
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
