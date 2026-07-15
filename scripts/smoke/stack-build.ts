import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LifecycleLedger } from "./stack-lifecycle.js";
import { runCommand } from "./stack-process.js";

function commandOptions(root: string, env: NodeJS.ProcessEnv, ledger: LifecycleLedger, capture = false) {
  return {
    cwd: root,
    env,
    capture,
    quiet: true as const,
    signal: ledger.abortController.signal,
    onSpawn: (evidence: { command: string; args: readonly string[] }) => ledger.recordCommand(evidence),
    onGroup: (pgid: number, state: "started" | "exited") => ledger.recordGroup(pgid, state),
  };
}

/** Isolated Git env: no global/system config, no host attributes, no ambient identity. */
export function isolatedGitEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, "xdg-config");
  env.XDG_CACHE_HOME = join(home, "xdg-cache");
  env.XDG_DATA_HOME = join(home, "xdg-data");
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = "core.attributesFile";
  env.GIT_CONFIG_VALUE_0 = "/dev/null";
  env.GIT_CONFIG_KEY_1 = "core.excludesFile";
  env.GIT_CONFIG_VALUE_1 = "/dev/null";
  env.GIT_CONFIG_KEY_2 = "safe.directory";
  env.GIT_CONFIG_VALUE_2 = "*";
  return env;
}

interface TreeEntry {
  mode: string;
  type: string;
  hash: string;
  path: string;
}

function parseLsTree(raw: string): TreeEntry[] {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(?<mode>\d{6}) (?<type>blob|tree|commit) (?<hash>[0-9a-f]{40})\t(?<path>[\s\S]+)$/u.exec(line);
      if (match?.groups === undefined) throw new Error(`unrecognized ls-tree line: ${line}`);
      return {
        mode: match.groups["mode"]!,
        type: match.groups["type"]!,
        hash: match.groups["hash"]!,
        path: match.groups["path"]!,
      };
    });
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha1")
    .update(await readFile(path))
    .digest("hex");
}

function gitBlobHash(body: Buffer): string {
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

/**
 * Bind the build context to the recorded commit only: isolated bare object store,
 * no global/system config or host attributes, archive the exact commit, then verify
 * modes and blob identities against the tree.
 */
export async function createCleanBuildContext(
  root: string,
  head: string,
  tree: string,
  env: NodeJS.ProcessEnv,
  ledger: LifecycleLedger,
  remember: (base: string) => void,
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "tanren-smoke-source-"));
  remember(base);
  const home = join(base, "home");
  const bare = join(base, "objects.git");
  const source = join(base, "source");
  await mkdir(home, { mode: 0o700 });
  await mkdir(source);
  const gitEnv = isolatedGitEnv(env, home);
  await runCommand("git", ["init", "--bare", "-q", bare], commandOptions(root, gitEnv, ledger));
  const gitDirectory = (
    await runCommand("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-dir"], {
      ...commandOptions(root, gitEnv, ledger, true),
    })
  ).stdout.trim();
  await runCommand(
    "git",
    ["--git-dir", bare, "fetch", "--no-tags", "--depth=1", pathToFileURL(gitDirectory).href, head],
    commandOptions(root, gitEnv, ledger),
  );
  const resolved = (
    await runCommand("git", ["--git-dir", bare, "rev-parse", "FETCH_HEAD"], commandOptions(root, gitEnv, ledger, true))
  ).stdout.trim();
  if (resolved !== head) throw new Error(`bare store resolved ${resolved}, expected commit ${head}`);
  const resolvedTree = (
    await runCommand(
      "git",
      ["--git-dir", bare, "rev-parse", "FETCH_HEAD^{tree}"],
      commandOptions(root, gitEnv, ledger, true),
    )
  ).stdout.trim();
  if (resolvedTree !== tree) throw new Error(`commit ${head} resolved tree ${resolvedTree}, expected ${tree}`);
  const archive = join(base, "source.tar");
  await runCommand(
    "git",
    ["--git-dir", bare, "archive", "--format=tar", `--output=${archive}`, head],
    commandOptions(root, gitEnv, ledger),
  );
  await runCommand("tar", ["-xf", archive, "-C", source], commandOptions(root, gitEnv, ledger));
  const manifest = (
    await runCommand("git", ["--git-dir", bare, "ls-tree", "-rz", tree], commandOptions(root, gitEnv, ledger, true))
  ).stdout;
  const entries = parseLsTree(manifest);
  if (entries.length === 0) throw new Error("commit tree produced an empty manifest");
  for (const entry of entries) {
    if (entry.type === "commit") throw new Error(`submodule ${entry.path} is not supported in an exact smoke context`);
    if (entry.type !== "blob") continue;
    const absolute = join(source, entry.path);
    const info = await lstat(absolute);
    const expectedLink = entry.mode === "120000";
    if (expectedLink ? !info.isSymbolicLink() : !info.isFile()) {
      throw new Error(`archived path ${entry.path} has the wrong filesystem type for mode ${entry.mode}`);
    }
    const mode = (info.mode & 0o777).toString(8).padStart(6, "0");
    // Git blob modes are 100644 / 100755; compare executable bit only.
    const expectedExec = entry.mode === "100755";
    const actualExec = (info.mode & 0o111) !== 0;
    if (!expectedLink && expectedExec !== actualExec) {
      throw new Error(`mode mismatch for ${entry.path}: tree=${entry.mode} archive=${mode}`);
    }
    const body = expectedLink ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    const blob = gitBlobHash(body);
    if (blob !== entry.hash) {
      throw new Error(`blob identity mismatch for ${entry.path}: tree=${entry.hash} archive=${blob}`);
    }
  }
  // Touch a proof file that poison attributes would rewrite if host attrs leaked.
  await writeFile(join(base, "manifest.sha256"), createHash("sha256").update(manifest).digest("hex"), {
    mode: 0o600,
  });
  const dependencies = join(root, "node_modules");
  try {
    if ((await lstat(dependencies)).isDirectory()) await symlink(dependencies, join(source, "node_modules"), "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return source;
}

export async function fingerprintTree(root: string): Promise<string> {
  const entries: string[] = [];
  const forbidden = new Set([".env", ".env.validation.local", "connections.manifest.local.yaml"]);
  const opaqueToolDirectories = new Set([
    "node_modules",
    ".turbo",
    ".pnpm-store",
    ".codex",
    ".claude",
    "coverage",
    "dist",
  ]);
  async function walk(relative: string): Promise<void> {
    const absolute = relative === "" ? root : join(root, relative);
    const listing = await readdir(absolute, { withFileTypes: true });
    for (const entry of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const child = relative === "" ? entry.name : join(relative, entry.name);
      if (forbidden.has(child)) throw new Error(`checkout contains forbidden local secret path ${child}`);
      const target = join(root, child);
      const info = await lstat(target);
      if (relative === "" && opaqueToolDirectories.has(entry.name)) {
        entries.push(
          entry.isSymbolicLink()
            ? `${child}|opaque-symlink|${info.mode}|${await readlink(target)}`
            : `${child}|opaque-tool-directory|${info.mode}`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        entries.push(`${child}|directory|${info.mode}`);
        await walk(child);
      } else if (entry.isFile()) entries.push(`${child}|file|${info.mode}|${await hashFile(target)}`);
      else if (entry.isSymbolicLink()) entries.push(`${child}|symlink|${info.mode}|${await readlink(target)}`);
      else entries.push(`${child}|special|${info.mode}|${info.size}|${info.rdev}`);
    }
  }
  await walk("");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

export async function removeBuildBase(base: string | undefined): Promise<void> {
  if (base === undefined) return;
  await rm(base, { recursive: true, force: true });
}
