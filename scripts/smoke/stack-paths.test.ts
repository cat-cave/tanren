import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertArtifactPathSafe, canonicalPath, validateSmokePaths } from "./stack-paths.js";

// cspell:ignore gitdir

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tanren-paths-"));
  roots.push(root);
  await mkdir(join(root, "checkout", ".git"), { recursive: true });
  await mkdir(join(root, "outside"));
  return root;
}

afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("smoke path containment", () => {
  it("rejects traversal and symlink aliases into checkout or runtime cleanup roots", async () => {
    const root = await workspace();
    const checkout = join(root, "checkout");
    const runtime = join(root, "outside", "runtime", "run");
    await mkdir(runtime, { recursive: true });
    const alias = join(root, "outside", "checkout-alias");
    await symlink(checkout, alias);

    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase: join(root, "outside", "runtime"),
        runtimeDir: runtime,
        receiptPath: join(alias, "ignored", "receipt.json"),
      }),
    ).rejects.toThrow(/protected checkout/u);
    await expect(
      assertArtifactPathSafe(join(root, "outside", "x", "..", "runtime", "run", "receipt.json"), [runtime]),
    ).rejects.toThrow(/overlaps protected root/u);
  });

  it("canonicalizes missing leaves through existing symlink ancestors", async () => {
    const root = await workspace();
    const target = join(root, "outside", "artifacts");
    await mkdir(target);
    const alias = join(root, "alias");
    await symlink(target, alias);
    expect(await canonicalPath(join(alias, "missing", "receipt.json"))).toBe(join(target, "missing", "receipt.json"));
  });

  it("rejects runtime state under linked-worktree Git storage", async () => {
    const root = await workspace();
    const checkout = join(root, "linked");
    const gitRoot = join(root, "outside", "worktrees", "linked");
    await mkdir(checkout);
    await mkdir(gitRoot, { recursive: true });
    await writeFile(join(checkout, ".git"), `gitdir: ${gitRoot}\n`);
    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase: gitRoot,
        runtimeDir: join(gitRoot, "smoke", "run"),
        receiptPath: join(root, "outside", "receipt.json"),
      }),
    ).rejects.toThrow(/protected checkout path/u);
  });

  // Audit pass-6 regressions: a literal `..cache` child segment is a TRUE child
  // (not parent traversal), so a naive startsWith("..") overlap rule would let a
  // nested path silently bypass the containment guard in both directions.
  it("rejects a runtime nested under the checkout through a literal ..cache segment", async () => {
    const root = await workspace();
    const checkout = join(root, "checkout");
    const runtime = join(checkout, "..cache", "runtime", "run");
    await mkdir(runtime, { recursive: true });
    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase: join(checkout, "..cache", "runtime"),
        runtimeDir: runtime,
        receiptPath: join(root, "outside", "receipt.json"),
      }),
    ).rejects.toThrow(/overlaps protected checkout/u);
  });

  it("rejects a checkout nested under the runtime through a literal ..cache segment (reverse direction)", async () => {
    const root = await workspace();
    const runtimeBase = join(root, "outside", "runtime");
    const runtime = join(runtimeBase, "run");
    const checkout = join(runtime, "..cache", "checkout");
    await mkdir(join(checkout, ".git"), { recursive: true });
    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase,
        runtimeDir: runtime,
        receiptPath: join(root, "receipts", "receipt.json"),
      }),
    ).rejects.toThrow(/overlaps protected checkout/u);
  });

  it("does not overlap exact parent escapes (siblings reached via ..)", async () => {
    const root = await workspace();
    const checkout = join(root, "checkout");
    const sibling = join(root, "outside-runtime");
    const runtime = join(sibling, "run");
    await mkdir(runtime, { recursive: true });
    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase: sibling,
        runtimeDir: runtime,
        receiptPath: join(root, "outside", "receipt.json"),
      }),
    ).resolves.toBeDefined();
  });

  it("does not overlap prefix siblings that share a textual prefix with the checkout", async () => {
    const root = await workspace();
    const checkout = join(root, "checkout");
    const sibling = join(root, "checkout-sibling");
    const runtime = join(sibling, "run");
    await mkdir(runtime, { recursive: true });
    await expect(
      validateSmokePaths({
        checkoutRoot: checkout,
        runtimeBase: sibling,
        runtimeDir: runtime,
        receiptPath: join(root, "outside", "receipt.json"),
      }),
    ).resolves.toBeDefined();
  });
});
