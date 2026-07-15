import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCleanBuildContext,
  defaultInstallMaterializer,
  removeBuildBase,
  type InstallNetworkPolicy,
} from "./stack-build.js";
import { seedCorepackCache, type CorepackCacheSeed } from "./stack-build-corepack.js";
import { LifecycleLedger } from "./stack-lifecycle.js";

const roots: string[] = [];
const bases: string[] = [];

afterEach(() =>
  Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...bases.splice(0).map((base) => rm(base, { recursive: true, force: true })),
  ]),
);

// Cold-host per-test budgets for tests that perform real Corepack prefetch
// (`corepack pnpm --version` may fetch pnpm@11.1.0 on a fresh CI runner) or a
// real pnpm install. Bounded so a true hang still fails loud; scoped per-test
// (never global) so pure unit tests keep the 5s default.
// Wall-clock: prefetch ~3-12s, workspace-offline install ~2-6s on cold CI.
const COREPACK_PREFETCH_TEST_TIMEOUT_MS = 30_000;
const PNPM_INSTALL_TEST_TIMEOUT_MS = 60_000;

/** Walk a directory tree and fail if any symlink resolves outside the boundary. */
async function assertNoSymlinkEscapes(directory: string, boundary: string): Promise<void> {
  const realBoundary = await realpath(boundary);
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(target);
        if (resolved !== realBoundary && !resolved.startsWith(`${realBoundary}/`)) {
          throw new Error(`symlink ${target} escapes the build base: -> ${resolved}`);
        }
      }
      if (entry.isDirectory()) stack.push(target);
    }
  }
}

const PINNED_PACKAGE_MANAGER = "pnpm@11.1.0";

/**
 * Prepare the exact pnpm@11.1.0 Corepack cache OUTSIDE the protected invocation.
 * Uses a throwaway COREPACK_HOME so the network fetch (if any) happens here, not
 * during the install. Returns the prefetched cache root for copying into an owned
 * build base. The prefetch command itself must report exactly `11.1.0`.
 */
async function prefetchPinnedCorepackCache(): Promise<{ sourceRoot: string; version: string }> {
  const home = await mkdtemp(join(tmpdir(), "tanren-corepack-prefetch-"));
  bases.push(home);
  const stash = await mkdtemp(join(tmpdir(), "tanren-pinned-pm-"));
  bases.push(stash);
  await writeFile(join(stash, "package.json"), `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`);
  const version = execFileSync("corepack", ["pnpm", "--version"], {
    cwd: stash,
    encoding: "utf8",
    env: { ...process.env, COREPACK_HOME: home },
  }).trim();
  return { sourceRoot: home, version };
}

/**
 * Strict-offline network policy: forces --offline + COREPACK_ENABLE_NETWORK=0 and
 * passes only a data-only cache-seed descriptor (the prefetched pnpm@11.1.0 cache
 * root and exact packageManager string) through to the production materializer,
 * which validates and byte-copies the seed into the owned build base before the
 * protected invocation — no symlink, no candidate-checkout resolution.
 */
function strictOfflinePolicy(sourceRoot: string): InstallNetworkPolicy {
  return {
    mode: "offline",
    corepackCacheSeed: { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER },
  };
}

describe("strict offline install materialization", () => {
  // Real workspace-only pnpm fixture: workspace-local dependency, candidate poison,
  // no symlink escape, no candidate node_modules borrow, exact strict-offline evidence.
  it(
    "materializes a real offline pnpm workspace in strict offline mode without borrowing candidate node_modules or escaping the build base",
    { timeout: PNPM_INSTALL_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tanren-build-workspace-"));
      roots.push(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "smoke-workspace-root", private: true, packageManager: PINNED_PACKAGE_MANAGER })}\n`,
      );
      await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - db\n");
      await mkdir(join(root, "packages", "pg-fixture"), { recursive: true });
      await writeFile(
        join(root, "packages", "pg-fixture", "package.json"),
        `${JSON.stringify({ name: "@fixture/pg", version: "0.0.0", main: "index.js" })}\n`,
      );
      await writeFile(join(root, "packages", "pg-fixture", "index.js"), "module.exports = {};\n");
      await mkdir(join(root, "db"), { recursive: true });
      await writeFile(
        join(root, "db", "package.json"),
        `${JSON.stringify({ name: "@fixture/db", version: "0.0.0", private: true, dependencies: { "@fixture/pg": "workspace:*" } })}\n`,
      );
      // Generate a frozen-compatible lockfile by running a real install in the candidate
      // (workspace-only graph → fully offline, no registry fetch).
      execFileSync("corepack", ["pnpm", "install", "--prefer-offline", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
      });
      execFileSync("git", [
        "-C",
        root,
        "add",
        ".gitignore",
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "packages",
        "db",
      ]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "-qm",
        "workspace",
      ]);
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      // Poison the candidate's node_modules so we can prove the clean source never borrows it.
      await mkdir(join(root, "node_modules", "@fixture", "pg"), { recursive: true });
      await writeFile(join(root, "node_modules", "@fixture", "pg", "package.json"), '{"name":"poison"}\n');
      // Prefetch the exact pnpm@11.1.0 Corepack cache OUTSIDE the protected invocation.
      const prefetched = await prefetchPinnedCorepackCache();
      // The prefetch command reports exactly the pinned pnpm version — nothing else.
      expect(prefetched.version).toBe("11.1.0");
      const ledger = new LifecycleLedger();
      const source = await createCleanBuildContext(
        root,
        head,
        tree,
        process.env,
        ledger,
        (base) => bases.push(base),
        defaultInstallMaterializer,
        strictOfflinePolicy(prefetched.sourceRoot),
      );
      const base = dirname(source);
      // Package-local dependency resolves to the CLEAN source workspace package, not a candidate borrow.
      const depManifest = await readFile(join(source, "db", "node_modules", "@fixture", "pg", "package.json"), "utf8");
      expect(JSON.parse(depManifest).name).toBe("@fixture/pg");
      // Root poison is absent: the clean source never imported the candidate's poisoned node_modules.
      await expect(
        readFile(join(source, "node_modules", "@fixture", "pg", "package.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // No symlink under the materialized node_modules escapes the owned build base.
      await assertNoSymlinkEscapes(join(source, "node_modules"), base);
      await assertNoSymlinkEscapes(join(source, "db", "node_modules"), base);
      // Strict-offline bootstrap evidence: --offline (not --prefer-offline), frozen lockfile, owned
      // store, absolute corepack executable, exact clean-source cwd, group start+exit, passed status.
      const evidence = ledger.bootstrapInstallEvidence();
      expect(evidence).toMatchObject({ status: "passed", groupStarted: true, groupExited: true });
      expect(evidence!.command.cwd).toBe(source);
      expect(evidence!.command.executable).toMatch(/^\//u);
      expect(evidence!.command.args).toEqual(expect.arrayContaining(["install", "--frozen-lockfile", "--offline"]));
      expect(evidence!.command.args).not.toContain("--prefer-offline");
      expect(evidence!.command.args.join(" ")).toMatch(/--store-dir \S+/u);
      expect(evidence!.command.args.join(" ")).toContain(join(base, "cache", "pnpm-store"));
      expect(evidence!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(evidence!.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(evidence!.pgid).toBeTypeOf("number");
      // A real node_modules was materialized (not symlinked) inside the clean source.
      const nmInfo = await lstat(join(source, "node_modules"));
      expect(nmInfo.isDirectory()).toBe(true);
      expect(nmInfo.isSymbolicLink()).toBe(false);
    },
  );

  it(
    "fails closed in strict offline mode with an empty Corepack cache rather than reaching the network",
    { timeout: PNPM_INSTALL_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tanren-build-empty-cache-"));
      roots.push(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "smoke-empty-cache", private: true, packageManager: PINNED_PACKAGE_MANAGER })}\n`,
      );
      await writeFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
      );
      execFileSync("git", ["-C", root, "add", ".gitignore", "package.json", "pnpm-lock.yaml"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "-qm",
        "empty-cache",
      ]);
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      const ledger = new LifecycleLedger();
      // Strict offline mode with NO cache seed: corepack cannot download pnpm@11.1.0
      // (COREPACK_ENABLE_NETWORK=0) and must fail closed rather than reaching the registry.
      await expect(
        createCleanBuildContext(
          root,
          head,
          tree,
          process.env,
          ledger,
          (base) => bases.push(base),
          defaultInstallMaterializer,
          { mode: "offline" },
        ),
      ).rejects.toThrow(/Network access disabled|corepack|offline/iu);
      const evidence = ledger.bootstrapInstallEvidence();
      expect(evidence?.status).toBe("failed");
      expect(evidence?.command.args).toContain("--offline");
      expect(evidence?.command.args).not.toContain("--prefer-offline");
      expect(evidence?.error).toMatch(/Network access disabled|corepack|offline/iu);
      expect(bases).toHaveLength(1);
      await removeBuildBase(bases[0]);
      bases.length = 0;
    },
  );
});

describe("corepack cache seed validation", () => {
  // Negative controls for the data-only seed: production code rejects a mismatched
  // version and a symlinked seed before any bytes reach the owned COREPACK_HOME.
  it(
    "rejects a cache seed whose packageManager version does not match the pinned manifest",
    { timeout: COREPACK_PREFETCH_TEST_TIMEOUT_MS },
    async () => {
      const prefetched = await prefetchPinnedCorepackCache();
      expect(prefetched.version).toBe("11.1.0");
      const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-version-source-"));
      bases.push(cleanSource);
      await writeFile(
        join(cleanSource, "package.json"),
        `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
      );
      const destination = await mkdtemp(join(tmpdir(), "tanren-seed-version-dest-"));
      bases.push(destination);
      // A seed descriptor claiming the wrong version must fail closed before copying.
      const mismatched: CorepackCacheSeed = { sourceRoot: prefetched.sourceRoot, packageManager: "pnpm@11.0.0" };
      await expect(seedCorepackCache(mismatched, cleanSource, destination)).rejects.toThrow(
        /does not match cache seed|manifest.*is|expected pnpm@11\.0\.0/iu,
      );
      // The destination never received the seed bytes.
      await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it(
    "rejects a cache seed that contains a symlink before copying any bytes",
    { timeout: COREPACK_PREFETCH_TEST_TIMEOUT_MS },
    async () => {
      const prefetched = await prefetchPinnedCorepackCache();
      expect(prefetched.version).toBe("11.1.0");
      // Inject a symlink into the prefetched seed to simulate a tampered cache.
      const linkTarget = await mkdtemp(join(tmpdir(), "tanren-seed-link-target-"));
      bases.push(linkTarget);
      await writeFile(join(linkTarget, "stranger"), "outside\n");
      await symlink(linkTarget, join(prefetched.sourceRoot, "v1", "injected-link"));
      const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-link-source-"));
      bases.push(cleanSource);
      await writeFile(
        join(cleanSource, "package.json"),
        `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
      );
      const destination = await mkdtemp(join(tmpdir(), "tanren-seed-link-dest-"));
      bases.push(destination);
      const seeded: CorepackCacheSeed = { sourceRoot: prefetched.sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
      await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/symlink/u);
      // The destination stays empty with no manifest: the symlink blocked the copy
      // before any bytes reached the owned COREPACK_HOME (matching the socket control).
      await expect(readdir(destination)).resolves.toHaveLength(0);
      await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  // Path-segment-aware separation: the seed source must not be an ancestor or a
  // descendant of the destination (and must not equal it). Both nesting
  // directions are rejected before any bytes reach the owned COREPACK_HOME.
  it("rejects when the seed source is an ancestor of the destination before any copy", async () => {
    // Destination is nested UNDER the seed source (source is the ancestor).
    const sourceRoot = await mkdtemp(join(tmpdir(), "tanren-seed-ancestor-src-"));
    bases.push(sourceRoot);
    const destination = join(sourceRoot, "nested", "corepack-home");
    await mkdir(destination, { recursive: true });
    const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-ancestor-clean-"));
    bases.push(cleanSource);
    await writeFile(
      join(cleanSource, "package.json"),
      `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
    );
    const seeded: CorepackCacheSeed = { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
    await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/nested/iu);
    // No destination bytes are materialized: the pre-created destination stays empty.
    await expect(readdir(destination)).resolves.toHaveLength(0);
    await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects when the seed source is a descendant of the destination before any copy", async () => {
    // Seed source is nested UNDER the destination (destination is the ancestor).
    const destination = await mkdtemp(join(tmpdir(), "tanren-seed-descendant-dest-"));
    bases.push(destination);
    const sourceRoot = join(destination, "nested", "seed");
    await mkdir(sourceRoot, { recursive: true });
    const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-descendant-clean-"));
    bases.push(cleanSource);
    await writeFile(
      join(cleanSource, "package.json"),
      `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
    );
    const seeded: CorepackCacheSeed = { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
    await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/nested/iu);
    // No destination bytes are materialized: only the test-owned nested source dir exists.
    await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(destination, "v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reject sibling names that only share a textual prefix with the destination", async () => {
    // Sibling names sharing a textual prefix (tanren-seed-sibling-X vs -Y) must
    // NOT be mistaken for nesting by a raw string-prefix check. The separation
    // guard passes; the real rejection comes later from the missing manifest.
    const common = await mkdtemp(join(tmpdir(), "tanren-seed-sibling-"));
    bases.push(common);
    const sourceRoot = join(common, "seed");
    const destination = join(common, "seed-dest");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(destination, { recursive: true });
    const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-sibling-clean-"));
    bases.push(cleanSource);
    await writeFile(
      join(cleanSource, "package.json"),
      `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
    );
    const seeded: CorepackCacheSeed = { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
    // Siblings are allowed past the separation guard; the copy is blocked by the
    // missing pinned manifest instead, proving the prefix is segment-aware.
    await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/manifest/iu);
    await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // Hostile production-path regressions (audit pass-6): a literal `..cache`
  // child segment is a TRUE child (not parent traversal), so a naive
  // `startsWith("..")` overlap rule would silently let a nested seed bypass the
  // guard. Both nesting directions are rejected before any bytes are copied.
  it("rejects a destination nested under the seed through a literal ..cache segment before any copy", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "tanren-seed-cache-child-src-"));
    bases.push(sourceRoot);
    // A valid pinned manifest lives in the seed: the rejection must come from
    // path geometry (the overlap guard), not a missing manifest.
    await mkdir(join(sourceRoot, "v1", "pnpm", "11.1.0"), { recursive: true });
    await writeFile(
      join(sourceRoot, "v1", "pnpm", "11.1.0", "package.json"),
      `${JSON.stringify({ name: "pnpm", version: "11.1.0" })}\n`,
    );
    // Destination nested UNDER the seed via the literal ..cache segment.
    const destination = join(sourceRoot, "..cache", "corepack-home");
    await mkdir(destination, { recursive: true });
    const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-cache-child-clean-"));
    bases.push(cleanSource);
    await writeFile(
      join(cleanSource, "package.json"),
      `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
    );
    const seeded: CorepackCacheSeed = { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
    await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/nested/u);
    // The pre-created destination stays empty: the seed never recursed into itself.
    await expect(readdir(destination)).resolves.toHaveLength(0);
    await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a seed nested under the destination through a literal ..cache segment before any copy", async () => {
    const destination = await mkdtemp(join(tmpdir(), "tanren-seed-cache-rev-dest-"));
    bases.push(destination);
    // Seed nested UNDER the destination via the literal ..cache segment.
    const sourceRoot = join(destination, "..cache", "seed");
    await mkdir(sourceRoot, { recursive: true });
    // A valid pinned manifest so the rejection is path-geometric, not content-based.
    await mkdir(join(sourceRoot, "v1", "pnpm", "11.1.0"), { recursive: true });
    await writeFile(
      join(sourceRoot, "v1", "pnpm", "11.1.0", "package.json"),
      `${JSON.stringify({ name: "pnpm", version: "11.1.0" })}\n`,
    );
    const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-cache-rev-clean-"));
    bases.push(cleanSource);
    await writeFile(
      join(cleanSource, "package.json"),
      `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
    );
    const seeded: CorepackCacheSeed = { sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
    await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/nested/u);
    // No v1 bytes were copied into the destination ancestor.
    await expect(readdir(join(destination, "v1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it(
    "rejects a non-regular special entry (Unix domain socket) nested under the seed before copying",
    { timeout: COREPACK_PREFETCH_TEST_TIMEOUT_MS },
    async () => {
      const prefetched = await prefetchPinnedCorepackCache();
      expect(prefetched.version).toBe("11.1.0");
      // Inject a Unix domain socket DEEP under the seed to prove the recursive walk
      // rejects a non-regular/non-directory entry anywhere in the tree.
      const trappedDir = join(prefetched.sourceRoot, "v1", "trapped");
      await mkdir(trappedDir, { recursive: true });
      const socketPath = join(trappedDir, "injected-socket");
      const server = createServer();
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once("error", rejectListen);
          server.listen(socketPath, () => {
            server.removeListener("error", rejectListen);
            resolveListen();
          });
        });
        // Confirm the fixture really is a non-regular special entry.
        const info = await lstat(socketPath);
        expect(info.isFile()).toBe(false);
        expect(info.isDirectory()).toBe(false);
        expect(info.isSymbolicLink()).toBe(false);
        const cleanSource = await mkdtemp(join(tmpdir(), "tanren-seed-socket-clean-"));
        bases.push(cleanSource);
        await writeFile(
          join(cleanSource, "package.json"),
          `${JSON.stringify({ packageManager: PINNED_PACKAGE_MANAGER })}\n`,
        );
        const destination = await mkdtemp(join(tmpdir(), "tanren-seed-socket-dest-"));
        bases.push(destination);
        const seeded: CorepackCacheSeed = { sourceRoot: prefetched.sourceRoot, packageManager: PINNED_PACKAGE_MANAGER };
        await expect(seedCorepackCache(seeded, cleanSource, destination)).rejects.toThrow(/non-regular entry/u);
        // The destination never received any seed bytes.
        await expect(readdir(destination)).resolves.toHaveLength(0);
        await expect(readFile(join(destination, "v1", "pnpm", "11.1.0", "package.json"), "utf8")).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
      }
    },
  );
});
