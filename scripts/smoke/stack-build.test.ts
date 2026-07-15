import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCleanBuildContext, fingerprintTree, type InstallMaterializer } from "./stack-build.js";
import { LifecycleLedger } from "./stack-lifecycle.js";

const roots: string[] = [];
const bases: string[] = [];

async function repository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tanren-build-${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "tracked.txt"), `${name}\n`);
  await writeFile(join(root, "script.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  execFileSync("git", ["-C", root, "add", "tracked.txt", "script.sh"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-qm",
    name,
  ]);
  return root;
}

/**
 * Fixture materializer: writes a real `node_modules` directory inside the clean
 * source so archive/identity tests verify the source gets its own materialized
 * dependencies — never a candidate-root borrow. Production-path materialization
 * (real pnpm install) is proven in stack-build-install.test.ts.
 */
function recordingMaterializer(): InstallMaterializer {
  return async (source) => {
    await mkdir(join(source, "node_modules"), { recursive: true });
    await writeFile(join(source, "node_modules", ".installed"), "fixture\n", { mode: 0o600 });
  };
}

afterEach(() =>
  Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...bases.splice(0).map((base) => rm(base, { recursive: true, force: true })),
  ]),
);

describe("commit-bound build context", () => {
  it("archives the recorded commit, verifies blob/mode identity, and materializes dependencies in the source", async () => {
    const root = await repository("clean");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      process.env,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("clean\n");
    expect((await readFile(join(source, "script.sh"), "utf8")).startsWith("#!/bin/sh")).toBe(true);
    // Materialized node_modules is a real directory under the build base, never a symlink borrow.
    const nmInfo = await lstat(join(source, "node_modules"));
    expect(nmInfo.isDirectory()).toBe(true);
    expect(nmInfo.isSymbolicLink()).toBe(false);
    expect(await readFile(join(source, "node_modules", ".installed"), "utf8")).toBe("fixture\n");
  });

  it("archives a linked worktree through its resolved Git administration directory", async () => {
    const main = await repository("linked-main");
    const linkedParent = await mkdtemp(join(tmpdir(), "tanren-linked-parent-"));
    const linked = join(linkedParent, "candidate");
    roots.push(linkedParent);
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "smoke-linked", linked]);
    const head = execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", linked, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const source = await createCleanBuildContext(
      linked,
      head,
      tree,
      process.env,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("linked-main\n");
  });

  it("ignores poisoned host attributes and .git/info/attributes", async () => {
    const root = await repository("attrs");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "* filter=poison\n");
    const globalAttrs = join(root, "global-attributes");
    await writeFile(globalAttrs, "* filter=poison\n");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      { ...process.env, GIT_CONFIG_PARAMETERS: `'core.attributesFile=${globalAttrs}'` },
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("attrs\n");
    const before = await fingerprintTree(root);
    expect(await fingerprintTree(root)).toBe(before);
  });

  it("fingerprints directory symlinks without following their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-fingerprint-link-"));
    const external = await mkdtemp(join(tmpdir(), "tanren-fingerprint-external-"));
    roots.push(root, external);
    await writeFile(join(external, "secret"), "outside-one\n");
    await symlink(external, join(root, "linked-directory"));
    const first = await fingerprintTree(root);
    await writeFile(join(external, "secret"), "outside-two\n");
    expect(await fingerprintTree(root)).toBe(first);
    await rm(join(root, "linked-directory"));
    await symlink(`${external}-different-name`, join(root, "linked-directory"));
    expect(await fingerprintTree(root)).not.toBe(first);
  });

  it("treats ignored agent worktree directories as opaque checkout metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-fingerprint-agent-state-"));
    roots.push(root);
    await mkdir(join(root, ".codex", "worktrees", "nested"), { recursive: true });
    const nested = join(root, ".codex", "worktrees", "nested", ".env.validation.local");
    await writeFile(nested, "fixture-one\n");
    const first = await fingerprintTree(root);
    await writeFile(nested, "fixture-two\n");
    expect(await fingerprintTree(root)).toBe(first);
  });

  it("treats package-local node_modules as opaque so dependency bytes are never hashed as source", async () => {
    const root = await mkdtemp(join(tmpdir(), "tanren-fingerprint-nested-node-modules-"));
    roots.push(root);
    await mkdir(join(root, "db", "node_modules", "pg"), { recursive: true });
    const pkg = join(root, "db", "node_modules", "pg", "package.json");
    await writeFile(pkg, '{"name":"pg","version":"8.0.0"}\n');
    const first = await fingerprintTree(root);
    await writeFile(pkg, '{"name":"pg","version":"8.21.0"}\n');
    expect(await fingerprintTree(root)).toBe(first);
  });

  it("rejects a recorded tree that does not belong to the recorded commit", async () => {
    const root = await repository("tree-binding");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(root, "tracked.txt"), "second\n");
    execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "second",
    ]);
    const wrongTree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    await expect(
      createCleanBuildContext(root, head, wrongTree, process.env, new LifecycleLedger(), (base) => bases.push(base)),
    ).rejects.toThrow(/resolved tree/u);
  });
});
