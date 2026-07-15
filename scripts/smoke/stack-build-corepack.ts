import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Data-only descriptor for an externally prefetched Corepack cache. This type
 * intentionally carries no executable callback: a test can only name a seed
 * root and the exact expected `packageManager` string. Production code (in
 * {@link seedCorepackCache}) reads the clean source `package.json`, verifies
 * the seed's pinned manifest, rejects symlinks/non-regular entries, copies raw
 * bytes into the owned `COREPACK_HOME`, and re-verifies the copied manifest —
 * so no test-only authority can derive `<base>/source`, write `node_modules`,
 * rewrite package metadata, or populate the pnpm store.
 */
export interface CorepackCacheSeed {
  readonly sourceRoot: string;
  readonly packageManager: string;
}

interface ParsedPackageManager {
  readonly name: string;
  readonly version: string;
}

const PACKAGE_MANAGER_PATTERN = /^(?<name>@?[^\s@]+)@(?<version>.+)$/u;

function parsePackageManager(raw: string): ParsedPackageManager {
  const match = PACKAGE_MANAGER_PATTERN.exec(raw);
  if (match?.groups === undefined) {
    throw new Error(`corepack cache seed packageManager ${JSON.stringify(raw)} is not <name>@<version>`);
  }
  return { name: match.groups["name"]!, version: match.groups["version"]! };
}

function manifestPath(cacheRoot: string, parsed: ParsedPackageManager): string {
  return join(cacheRoot, "v1", parsed.name, parsed.version, "package.json");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Path-segment-aware overlap test: true when `candidate` is equal to or nested
 * under `ancestor`. Uses {@link relative} so sibling names that share a textual
 * prefix (e.g. `/a/b` and `/a/bc`) are NOT confused with nesting — `relative`
 * yields a leading `..` for siblings. Cross-drive Windows relatives come back
 * absolute and are treated as non-overlapping. `""` means the two paths are
 * equal.
 *
 * NATIVE-SEPARATOR-AWARE: only an exact `..` or a `..${sep}` prefix escapes
 * containment. A literal child segment like `..cache` is a TRUE child (not
 * parent traversal), so a naive `startsWith("..")` would misclassify it as an
 * escape and let a nested seed silently bypass the overlap guard.
 */
function isSameOrAncestorOf(ancestor: string, candidate: string): boolean {
  const rel = relative(ancestor, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function readCleanSourcePackageManager(cleanSource: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(cleanSource, "package.json"), "utf8");
  } catch (error) {
    throw new Error(`clean source package.json is not readable: ${describeError(error)}`, { cause: error });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("clean source package.json is not valid JSON");
  }
  const packageManager = (decoded as { packageManager?: unknown }).packageManager;
  if (typeof packageManager !== "string" || packageManager === "") {
    throw new Error("clean source package.json has no string packageManager");
  }
  return packageManager;
}

async function verifyManifest(path: string, label: string, parsed: ParsedPackageManager): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`corepack cache seed ${label} manifest ${path} is missing: ${describeError(error)}`, {
      cause: error,
    });
  }
  let decoded: { name?: unknown; version?: unknown };
  try {
    decoded = JSON.parse(raw) as { name?: unknown; version?: unknown };
  } catch {
    throw new Error(`corepack cache seed ${label} manifest ${path} is not valid JSON`);
  }
  if (decoded.name !== parsed.name || decoded.version !== parsed.version) {
    throw new Error(
      `corepack cache seed ${label} manifest ${path} is ${String(decoded.name)}@${String(decoded.version)}, expected ${parsed.name}@${parsed.version}`,
    );
  }
}

async function rejectLinksAndSpecialEntries(sourceRoot: string): Promise<void> {
  const stack = [sourceRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`corepack cache seed is not readable at ${current}: ${describeError(error)}`, { cause: error });
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`corepack cache seed contains a symlink at ${target}`);
      }
      if (entry.isDirectory()) stack.push(target);
      else if (!entry.isFile()) {
        throw new Error(`corepack cache seed contains a non-regular entry at ${target}`);
      }
    }
  }
}

async function copySeedTree(sourceRoot: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const stack: Array<{ source: string; destination: string }> = [{ source: sourceRoot, destination }];
  while (stack.length > 0) {
    const { source, destination: dest } = stack.pop()!;
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`corepack cache seed contains a symlink at ${join(source, entry.name)}`);
      }
      const sourceEntry = join(source, entry.name);
      const destinationEntry = join(dest, entry.name);
      if (entry.isDirectory()) {
        await mkdir(destinationEntry, { recursive: true, mode: 0o700 });
        stack.push({ source: sourceEntry, destination: destinationEntry });
      } else if (entry.isFile()) {
        await copyFile(sourceEntry, destinationEntry);
      } else {
        throw new Error(`corepack cache seed contains a non-regular entry at ${sourceEntry}`);
      }
    }
  }
}

/**
 * Validate and copy a data-only Corepack cache seed into the owned
 * `COREPACK_HOME`. Fails closed for any missing, mismatched, or symlinked
 * seed. Concretely the clean source `package.json` must declare the exact
 * `packageManager`, the seed must contain the matching
 * `v1/<name>/<version>/package.json` manifest, every entry must be a regular
 * file or directory (never a symlink or special file), the seed root must not
 * be equal to or nested with the destination in either direction (path-segment
 * aware, so sibling names are never mistaken for nesting), and the copied
 * manifest is re-verified after the byte copy.
 */
export async function seedCorepackCache(
  seed: CorepackCacheSeed,
  cleanSource: string,
  corepackHome: string,
): Promise<void> {
  const sourceRoot = resolve(seed.sourceRoot);
  const destination = resolve(corepackHome);
  if (isSameOrAncestorOf(sourceRoot, destination) || isSameOrAncestorOf(destination, sourceRoot)) {
    throw new Error("corepack cache seed source must not be equal to or nested with COREPACK_HOME in either direction");
  }
  const sourceRootInfo = await lstat(sourceRoot);
  if (sourceRootInfo.isSymbolicLink() || !sourceRootInfo.isDirectory()) {
    throw new Error(`corepack cache seed source ${sourceRoot} is not a regular directory`);
  }
  const sourcePackageManager = await readCleanSourcePackageManager(cleanSource);
  if (sourcePackageManager !== seed.packageManager) {
    throw new Error(
      `clean source packageManager ${JSON.stringify(sourcePackageManager)} does not match cache seed ${JSON.stringify(seed.packageManager)}`,
    );
  }
  const parsed = parsePackageManager(seed.packageManager);
  await verifyManifest(manifestPath(sourceRoot, parsed), "source", parsed);
  await rejectLinksAndSpecialEntries(sourceRoot);
  await copySeedTree(sourceRoot, destination);
  await verifyManifest(manifestPath(destination, parsed), "destination", parsed);
}
