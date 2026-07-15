import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCleanBuildContext, fingerprintTree } from "./stack-build.js";
import { LifecycleLedger } from "./stack-lifecycle.js";

const roots: string[] = [];

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

afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("commit-bound build context", () => {
  it("archives the recorded commit and verifies blob identity against the tree", async () => {
    const root = await repository("clean");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const bases: string[] = [];
    const source = await createCleanBuildContext(root, head, tree, process.env, new LifecycleLedger(), (base) =>
      bases.push(base),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("clean\n");
    expect((await readFile(join(source, "script.sh"), "utf8")).startsWith("#!/bin/sh")).toBe(true);
    await Promise.all(bases.map((base) => rm(base, { recursive: true, force: true })));
  });

  it("archives a linked worktree through its resolved Git administration directory", async () => {
    const main = await repository("linked-main");
    const linkedParent = await mkdtemp(join(tmpdir(), "tanren-linked-parent-"));
    const linked = join(linkedParent, "candidate");
    roots.push(linkedParent);
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "smoke-linked", linked]);
    const head = execFileSync("git", ["-C", linked, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", linked, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const bases: string[] = [];
    const source = await createCleanBuildContext(linked, head, tree, process.env, new LifecycleLedger(), (base) =>
      bases.push(base),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("linked-main\n");
    await Promise.all(bases.map((base) => rm(base, { recursive: true, force: true })));
  });

  it("ignores poisoned host attributes and .git/info/attributes", async () => {
    const root = await repository("attrs");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "attributes"), "* filter=poison\n");
    const globalAttrs = join(root, "global-attributes");
    await writeFile(globalAttrs, "* filter=poison\n");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const bases: string[] = [];
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      { ...process.env, GIT_CONFIG_PARAMETERS: `'core.attributesFile=${globalAttrs}'` },
      new LifecycleLedger(),
      (base) => bases.push(base),
    );
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("attrs\n");
    const before = await fingerprintTree(root);
    expect(await fingerprintTree(root)).toBe(before);
    await Promise.all(bases.map((base) => rm(base, { recursive: true, force: true })));
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
    const bases: string[] = [];
    await expect(
      createCleanBuildContext(root, head, wrongTree, process.env, new LifecycleLedger(), (base) => bases.push(base)),
    ).rejects.toThrow(/resolved tree/u);
    await Promise.all(bases.map((base) => rm(base, { recursive: true, force: true })));
  });
});
