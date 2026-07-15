import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// cspell:ignore gitdir

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve symlinks in every existing ancestor without requiring the leaf to exist. */
export async function canonicalPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`no existing ancestor for ${path}`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...missing);
}

/**
 * Native-separator-aware containment test on a {@link relative} result: `""`
 * is equality; an absolute value is a cross-drive (Windows) non-overlap; only
 * an exact `..` or a `..${sep}` prefix escapes containment. A literal child
 * segment like `..cache` is a TRUE child, not parent traversal — a naive
 * `startsWith("..")` would misclassify it and let nested paths bypass the
 * overlap guard (audit pass-6 bypass).
 */
function isContainedRelativePath(value: string): boolean {
  if (value === "") return true;
  if (isAbsolute(value)) return false;
  return value !== ".." && !value.startsWith(`..${sep}`);
}

export function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return isContainedRelativePath(leftToRight) || isContainedRelativePath(rightToLeft);
}

async function gitStorageRoot(checkoutRoot: string): Promise<string> {
  const dotGit = join(checkoutRoot, ".git");
  const info = await lstat(dotGit);
  if (info.isDirectory()) return realpath(dotGit);
  const match = /^gitdir:\s*(.+)\s*$/u.exec(await readFile(dotGit, "utf8"));
  if (match?.[1] === undefined) throw new Error(`${dotGit} is not a Git directory or gitdir file`);
  return canonicalPath(resolve(checkoutRoot, match[1]));
}

export interface ValidatedSmokePaths {
  checkoutRoot: string;
  gitRoot: string;
  runtimeBase: string;
  runtimeDir: string;
  receiptPath: string;
}

export async function validateSmokePaths(input: {
  checkoutRoot: string;
  runtimeBase: string;
  runtimeDir: string;
  receiptPath: string;
}): Promise<ValidatedSmokePaths> {
  const checkoutRoot = await canonicalPath(input.checkoutRoot);
  const gitRoot = await gitStorageRoot(checkoutRoot);
  const runtimeBase = await canonicalPath(input.runtimeBase);
  const runtimeDir = await canonicalPath(input.runtimeDir);
  const receiptPath = await canonicalPath(input.receiptPath);
  for (const protectedRoot of [checkoutRoot, gitRoot]) {
    if (pathsOverlap(runtimeDir, protectedRoot)) {
      throw new Error(`runtime path ${runtimeDir} overlaps protected checkout path ${protectedRoot}`);
    }
    if (pathsOverlap(receiptPath, protectedRoot)) {
      throw new Error(`receipt path ${receiptPath} overlaps protected checkout path ${protectedRoot}`);
    }
  }
  if (pathsOverlap(receiptPath, runtimeDir)) {
    throw new Error(`receipt path ${receiptPath} overlaps cleanup root ${runtimeDir}`);
  }
  return { checkoutRoot, gitRoot, runtimeBase, runtimeDir, receiptPath };
}

export async function assertArtifactPathSafe(
  path: string,
  forbiddenRoots: readonly string[],
  checkoutRoot?: string,
): Promise<string> {
  const protectedRoots = [...forbiddenRoots, ...(checkoutRoot === undefined ? [] : [checkoutRoot])];
  const validate = async () => {
    const candidate = await canonicalPath(path);
    for (const root of protectedRoots.filter(Boolean)) {
      const protectedRoot = await canonicalPath(root);
      if (pathsOverlap(candidate, protectedRoot)) {
        throw new Error(`artifact path ${candidate} overlaps protected root ${protectedRoot}`);
      }
    }
    return candidate;
  };
  await validate();
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  return validate();
}
