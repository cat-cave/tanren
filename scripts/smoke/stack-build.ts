import { createHash } from "node:crypto";
import { access, constants, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { seedCorepackCache, type CorepackCacheSeed } from "./stack-build-corepack.js";
import type { LifecycleLedger } from "./stack-lifecycle.js";
import { runCommand, type CommandEvidence } from "./stack-process.js";

function commandOptions(root: string, env: NodeJS.ProcessEnv, ledger: LifecycleLedger, capture = false) {
  return {
    cwd: root,
    env,
    capture,
    quiet: true as const,
    signal: ledger.abortController.signal,
    onSpawn: (evidence: CommandEvidence) => ledger.recordCommand(evidence),
    onGroup: (pgid: number, state: "started" | "exited") => ledger.recordGroup(pgid, state),
  };
}

/** Isolated Git env: no global/system config, no host attributes, no ambient identity. */
export function isolatedGitEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env["HOME"] = home;
  env["XDG_CONFIG_HOME"] = join(home, "xdg-config");
  env["XDG_CACHE_HOME"] = join(home, "xdg-cache");
  env["XDG_DATA_HOME"] = join(home, "xdg-data");
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_ATTR_NOSYSTEM"] = "1";
  env["GIT_CONFIG_COUNT"] = "3";
  env["GIT_CONFIG_KEY_0"] = "core.attributesFile";
  env["GIT_CONFIG_VALUE_0"] = "/dev/null";
  env["GIT_CONFIG_KEY_1"] = "core.excludesFile";
  env["GIT_CONFIG_VALUE_1"] = "/dev/null";
  env["GIT_CONFIG_KEY_2"] = "safe.directory";
  env["GIT_CONFIG_VALUE_2"] = "*";
  return env;
}

/**
 * Fixed system executable directories a Linux/Nix smoke host needs to resolve
 * sh, tar, git, and corepack. Never includes candidate/home/tmp/node_modules
 * entries. The install PATH is CONSTRUCTED from these plus the Node executable
 * directory — never copied from the ambient PATH.
 */
const SYSTEM_PATH_ENTRIES = ["/run/current-system/sw/bin", "/usr/local/bin", "/usr/bin", "/bin"] as const;

/**
 * Exact allowlist of environment keys the dependency install is permitted to
 * see. Anything outside this set is never constructed into the install env, so
 * DATABASE_URL, TANREN_*, GitHub, provider, cloud and runner keys, arbitrary
 * auth, NODE_OPTIONS, npm/pnpm/yarn/corepack config, proxy/CA overrides, and
 * the ambient PATH cannot reach the install process.
 */
export const INSTALL_ENV_ALLOWED_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "COREPACK_HOME",
  "COREPACK_ENABLE_NETWORK",
  "TMPDIR",
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "PATH",
] as const;

/**
 * Trusted install PATH: the Node executable directory (where corepack ships)
 * followed by fixed system executable directories. Never the ambient PATH.
 */
export function trustedInstallPath(): string {
  const nodeDir = dirname(process.execPath);
  return [...new Set([nodeDir, ...SYSTEM_PATH_ENTRIES])].join(delimiter);
}

/**
 * Resolve corepack on a trusted PATH, returning the absolute executable. Fails
 * closed if corepack is not executable on any trusted directory — the install
 * never falls back to an ambient PATH lookup.
 */
export async function assertCorepackResolvable(path: string): Promise<string> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "corepack");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the trusted PATH.
    }
  }
  throw new Error("corepack is not resolvable on the trusted install PATH; refusing dependency install");
}

/**
 * Constructed install environment: only the keys in INSTALL_ENV_ALLOWED_KEYS,
 * all owned under the build base (HOME/cache/config/state + an owned TMPDIR) or
 * deterministic benign values (CI/locale/TZ). The ambient environment is never
 * inherited — there is no copy step, so nothing hostile can leak in.
 * `COREPACK_ENABLE_NETWORK` is first-class policy state constructed from the
 * typed network policy: `"1"` for production prefer-offline, `"0"` for strict
 * offline — never copied from an ambient value.
 */
export function isolatedInstallEnv(
  home: string,
  cache: string,
  tmp: string,
  network: InstallNetworkPolicy,
): NodeJS.ProcessEnv {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_STATE_HOME: join(home, "xdg-state"),
    COREPACK_HOME: join(cache, "corepack"),
    COREPACK_ENABLE_NETWORK: network.mode === "offline" ? "0" : "1",
    TMPDIR: tmp,
    CI: "true",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PATH: trustedInstallPath(),
  };
}

/**
 * Network policy for the dependency install. Production defaults to
 * prefer-offline against an owned empty store (frozen lockfile). Strict offline
 * mode forces `--offline`, sets Corepack's no-network control
 * (`COREPACK_ENABLE_NETWORK=0`, constructed in `isolatedInstallEnv`), and
 * optionally copies a validated Corepack cache seed into the owned build base
 * before the protected invocation so the exact pinned package manager is
 * resolvable without any network reach. The seed is a data-only descriptor
 * (no executable callback): production code in `seedCorepackCache` reads the
 * clean source `package.json`, verifies the seed's exact pinned manifest,
 * rejects symlinks/non-regular entries, copies bytes into the owned
 * `COREPACK_HOME`, then re-verifies the copied manifest.
 */
export interface InstallNetworkPolicy {
  readonly mode: "prefer-offline" | "offline";
  readonly corepackCacheSeed?: CorepackCacheSeed;
}

/** Production default: prefer-offline frozen-lockfile against an owned store. */
export const DEFAULT_INSTALL_NETWORK_POLICY: InstallNetworkPolicy = { mode: "prefer-offline" };

/** Injectable dependency-materializer seam. Default is the real frozen-lockfile install. */
export interface InstallMaterializer {
  (
    source: string,
    env: NodeJS.ProcessEnv,
    storeDir: string,
    ledger: LifecycleLedger,
    network: InstallNetworkPolicy,
  ): Promise<void>;
}

/**
 * Production install: resolve corepack on the trusted PATH (fail closed), then
 * `corepack pnpm install --frozen-lockfile <--prefer-offline|--offline>
 * --store-dir <owned>` with cwd exactly the clean source and an explicit owned
 * pnpm store. Installed link farms live under the clean source; resolution
 * never traverses the candidate checkout. The exact constructed environment
 * (including the policy-derived `COREPACK_ENABLE_NETWORK`) is passed straight
 * to the child with no later spread/overlay. In strict offline mode a data-only
 * cache seed is validated and byte-copied into the owned `COREPACK_HOME` before
 * the protected invocation. Records a distinct bootstrap install ledger entry
 * (executable/argv/cwd/pgid/group+exit) and fails closed — sealing failed
 * evidence and rethrowing — on nonzero install.
 */
export async function defaultInstallMaterializer(
  source: string,
  env: NodeJS.ProcessEnv,
  storeDir: string,
  ledger: LifecycleLedger,
  network: InstallNetworkPolicy = DEFAULT_INSTALL_NETWORK_POLICY,
): Promise<void> {
  const offline = network.mode === "offline";
  const args = [
    "pnpm",
    "install",
    "--frozen-lockfile",
    offline ? "--offline" : "--prefer-offline",
    "--store-dir",
    storeDir,
  ];
  ledger.beginBootstrapInstall({ executable: "corepack", args, cwd: source });
  try {
    const corepackHome = env["COREPACK_HOME"];
    if (offline && network.corepackCacheSeed !== undefined) {
      if (corepackHome === undefined) {
        throw new Error("strict offline mode requires COREPACK_HOME in the install environment");
      }
      await seedCorepackCache(network.corepackCacheSeed, source, corepackHome);
    }
    const corepack = await assertCorepackResolvable(env["PATH"] ?? trustedInstallPath());
    await runCommand(corepack, args, {
      cwd: source,
      env,
      quiet: true,
      signal: ledger.abortController.signal,
      onSpawn: (evidence: CommandEvidence) => ledger.recordBootstrapInstallSpawn(evidence),
      onGroup: (pgid: number, state: "started" | "exited") => ledger.recordBootstrapInstallGroup(pgid, state),
    });
    ledger.completeBootstrapInstall("passed");
  } catch (error) {
    ledger.completeBootstrapInstall("failed", error);
    throw error;
  }
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
  materialize: InstallMaterializer = defaultInstallMaterializer,
  installNetwork: InstallNetworkPolicy = DEFAULT_INSTALL_NETWORK_POLICY,
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "tanren-smoke-source-"));
  remember(base);
  const home = join(base, "home");
  const bare = join(base, "objects.git");
  const source = join(base, "source");
  const cache = join(base, "cache");
  const tmp = join(base, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(source);
  await mkdir(cache, { mode: 0o700 });
  await mkdir(tmp, { mode: 0o700 });
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
  // Materialize dependencies inside the owned clean source after exact
  // archive/blob/mode verification and before any clean-source import. The
  // candidate checkout is never traversed for resolution; installed link farms
  // live under the clean source with a constructed (allowlisted) environment
  // isolated under the owned build base and an explicit owned pnpm store.
  const installEnv = isolatedInstallEnv(home, cache, tmp, installNetwork);
  const storeDir = join(cache, "pnpm-store");
  await materialize(source, installEnv, storeDir, ledger, installNetwork);
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
      if (opaqueToolDirectories.has(entry.name)) {
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
