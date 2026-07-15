import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCorepackResolvable,
  createCleanBuildContext,
  DEFAULT_INSTALL_NETWORK_POLICY,
  defaultInstallMaterializer,
  INSTALL_ENV_ALLOWED_KEYS,
  isolatedInstallEnv,
  removeBuildBase,
  trustedInstallPath,
  type InstallMaterializer,
  type InstallNetworkPolicy,
} from "./stack-build.js";
import { LifecycleLedger } from "./stack-lifecycle.js";
import { processGroupAbsent } from "./stack-process.js";

// cspell:ignore npm_config_cafile

const roots: string[] = [];
const bases: string[] = [];

async function repository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tanren-install-${name}-`));
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

/** Fixture materializer: writes a real node_modules in the source for seam/isolation assertions. */
function recordingMaterializer(
  invocations: Array<{ source: string; storeDir: string; env: NodeJS.ProcessEnv }>,
): InstallMaterializer {
  return async (source, env, storeDir) => {
    invocations.push({ source, storeDir, env: { ...env } });
    await mkdir(join(source, "node_modules"), { recursive: true });
    await writeFile(join(source, "node_modules", ".installed"), "fixture\n", { mode: 0o600 });
  };
}

const failingMaterializer: InstallMaterializer = async () => {
  throw new Error("synthetic install failure");
};

afterEach(() =>
  Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...bases.splice(0).map((base) => rm(base, { recursive: true, force: true })),
  ]),
);

// Cold-host per-test budget for the two tests that drive a real
// `corepack pnpm install --frozen-lockfile` (success + lockfile-drift failure).
// Bounded so a true hang still fails loud; scoped per-test (never global) so
// pure allowlist/unit tests keep the 5s default.
// Wall-clock: frozen-lockfile validation + corepack resolve ~3-10s on cold CI.
const PNPM_INSTALL_TEST_TIMEOUT_MS = 60_000;

describe("install environment allowlist", () => {
  // Hostile keys that must NEVER reach the install process. The install env is
  // CONSTRUCTED (not copied), so these cannot leak; this matrix is a regression
  // guard against re-introducing an ambient-env spread.
  const hostileKeys = [
    "DATABASE_URL",
    "TANREN_APP_DATABASE_URL",
    "TANREN_RUNNER_IDENTITY_KEY",
    "TANREN_RUNNER_AUTHORIZED_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_TOKEN",
    "GITHUB_PAT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NODE_OPTIONS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "npm_config_registry",
    "npm_config_cafile",
    "pnpm_config_store_dir",
    "YARN_CONFIG",
  ] as const;

  it("constructs only the exact allowed keys from owned paths — never inherits ambient auth/config/PATH", async () => {
    const env = isolatedInstallEnv("/base/home", "/base/cache", "/base/tmp", DEFAULT_INSTALL_NETWORK_POLICY);
    // Exact allowlist: any added or removed key fails this pin.
    expect(Object.keys(env).sort()).toEqual([...INSTALL_ENV_ALLOWED_KEYS].sort());
    // Owned build-base paths.
    expect(env["HOME"]).toBe("/base/home");
    expect(env["XDG_CONFIG_HOME"]).toBe(join("/base/home", "xdg-config"));
    expect(env["XDG_CACHE_HOME"]).toBe("/base/cache");
    expect(env["XDG_DATA_HOME"]).toBe(join("/base/home", "xdg-data"));
    expect(env["XDG_STATE_HOME"]).toBe(join("/base/home", "xdg-state"));
    expect(env["COREPACK_HOME"]).toBe(join("/base/cache", "corepack"));
    expect(env["TMPDIR"]).toBe("/base/tmp");
    // Deterministic benign values.
    expect(env["CI"]).toBe("true");
    expect(env["LANG"]).toBe("C.UTF-8");
    expect(env["LC_ALL"]).toBe("C.UTF-8");
    expect(env["TZ"]).toBe("UTC");
    // Production prefer-offline policy constructs COREPACK_ENABLE_NETWORK="1".
    expect(env["COREPACK_ENABLE_NETWORK"]).toBe("1");
    // Trusted PATH is constructed from the Node dir + fixed system dirs, never ambient.
    expect(env["PATH"]).toBe(trustedInstallPath());
    expect(env["PATH"]).not.toBe(process.env["PATH"]);
    expect(env["PATH"]).not.toMatch(/\/poisoned\/bin/u);
    expect(env["PATH"]).not.toMatch(/node_modules/u);
    // No hostile key survives — there is no copy step to leak from.
    for (const key of hostileKeys) expect(env[key]).toBeUndefined();
  });

  it('constructs COREPACK_ENABLE_NETWORK="0" for strict offline policy and never copies an ambient value', async () => {
    const ambient: NodeJS.ProcessEnv = {
      ...process.env,
      COREPACK_ENABLE_NETWORK: "1",
    };
    const env = isolatedInstallEnv("/base/home", "/base/cache", "/base/tmp", { mode: "offline" });
    // Offline policy forces "0" regardless of any ambient COREPACK_ENABLE_NETWORK.
    expect(env["COREPACK_ENABLE_NETWORK"]).toBe("0");
    expect(ambient["COREPACK_ENABLE_NETWORK"]).toBe("1");
    expect(Object.keys(env).sort()).toEqual([...INSTALL_ENV_ALLOWED_KEYS].sort());
  });

  it("fails closed when corepack is not resolvable on the trusted PATH", async () => {
    await expect(assertCorepackResolvable("/nonexistent-dir")).rejects.toThrow(/corepack is not resolvable/u);
  });
});

describe("clean-source dependency materialization", () => {
  it("passes only the constructed allowlist to the materializer, never the hostile ambient environment", async () => {
    const root = await repository("hostile-ambient");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const hostileAdditions = {
      DATABASE_URL: "postgres://u:p@h/d",
      TANREN_RUNNER_IDENTITY_KEY: "raw-private-key",
      TANREN_RUNNER_AUTHORIZED_KEY: "ssh-rsa marker_key",
      GITHUB_TOKEN: "token_marker_value",
      AWS_ACCESS_KEY_ID: "access_marker_value",
      AWS_SECRET_ACCESS_KEY: "secret_marker_value",
      NODE_OPTIONS: "--require /poisoned/probe",
      HTTP_PROXY: "http://poisoned-proxy",
      HTTPS_PROXY: "http://poisoned-proxy",
      NODE_EXTRA_CA_CERTS: "/poisoned/ca.pem",
      npm_config_registry: "https://poisoned-registry",
      npm_config_cafile: "/poisoned/npm-ca",
      pnpm_config_store_dir: "/poisoned/store",
      YARN_CONFIG: "/poisoned/yarn",
    } as Record<string, string>;
    const hostile: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `/poisoned/bin:${process.env["PATH"] ?? ""}`,
      COREPACK_ENABLE_NETWORK: "1",
      ...hostileAdditions,
    };
    const invocations: Array<{ source: string; storeDir: string; env: NodeJS.ProcessEnv }> = [];
    await createCleanBuildContext(
      root,
      head,
      tree,
      hostile,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(invocations),
    );
    expect(invocations).toHaveLength(1);
    const observed = invocations[0]!.env;
    // Exact constructed allowlist — fails if the ambient env is ever passed directly.
    expect(Object.keys(observed).sort()).toEqual([...INSTALL_ENV_ALLOWED_KEYS].sort());
    // Trusted PATH, never the poisoned ambient PATH.
    expect(observed["PATH"]).toBe(trustedInstallPath());
    expect(observed["PATH"]).not.toMatch(/\/poisoned|node_modules/u);
    // Production prefer-offline policy constructs COREPACK_ENABLE_NETWORK="1" at the
    // materializer seam, not from any ambient value.
    expect(observed["COREPACK_ENABLE_NETWORK"]).toBe("1");
    // No hostile value survives the constructed environment.
    for (const key of Object.keys(hostileAdditions)) expect(observed[key]).toBeUndefined();
    // Owned store lives under the build base (sibling of the clean source), never the candidate.
    expect(invocations[0]!.storeDir).toBe(join(dirname(invocations[0]!.source), "cache", "pnpm-store"));
    expect(observed["HOME"]).toBe(join(dirname(invocations[0]!.source), "home"));
    expect(observed["COREPACK_HOME"]).toBe(join(dirname(invocations[0]!.source), "cache", "corepack"));
  });

  it('threads strict-offline policy to the materializer seam with COREPACK_ENABLE_NETWORK="0" and exact keys', async () => {
    const root = await repository("offline-seam");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const hostile: NodeJS.ProcessEnv = {
      ...process.env,
      COREPACK_ENABLE_NETWORK: "1",
      DATABASE_URL: "postgres://u:p@h/d",
      NODE_OPTIONS: "--require /poisoned/probe",
    };
    const invocations: Array<{ source: string; storeDir: string; env: NodeJS.ProcessEnv }> = [];
    const offlinePolicy: InstallNetworkPolicy = { mode: "offline" };
    await createCleanBuildContext(
      root,
      head,
      tree,
      hostile,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(invocations),
      offlinePolicy,
    );
    expect(invocations).toHaveLength(1);
    const observed = invocations[0]!.env;
    // Offline policy produces the exact allowed-key contract with COREPACK_ENABLE_NETWORK="0".
    expect(Object.keys(observed).sort()).toEqual([...INSTALL_ENV_ALLOWED_KEYS].sort());
    expect(observed["COREPACK_ENABLE_NETWORK"]).toBe("0");
    // The ambient hostile values never reached the seam.
    expect(observed["DATABASE_URL"]).toBeUndefined();
    expect(observed["NODE_OPTIONS"]).toBeUndefined();
  });

  it("never borrows the candidate node_modules even when poisoned or present", async () => {
    const root = await repository("poisoned-deps");
    await mkdir(join(root, "node_modules", "pg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pg", "package.json"), '{"name":"poison"}\n');
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const invocations: Array<{ source: string; storeDir: string; env: NodeJS.ProcessEnv }> = [];
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      process.env,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer(invocations),
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.source).toBe(source);
    // The clean source node_modules was materialized by the fixture, not symlinked from candidate.
    const nmInfo = await lstat(join(source, "node_modules"));
    expect(nmInfo.isSymbolicLink()).toBe(false);
    expect(nmInfo.isDirectory()).toBe(true);
    // The candidate's poisoned node_modules/pg never leaked into the clean source.
    await expect(readFile(join(source, "node_modules", "pg", "package.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never borrows the candidate node_modules when it is missing", async () => {
    const root = await repository("no-deps");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      process.env,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer([]),
    );
    expect((await lstat(join(source, "node_modules"))).isDirectory()).toBe(true);
  });

  it(
    "runs the real frozen-lockfile install in the clean source and records bootstrap evidence",
    { timeout: PNPM_INSTALL_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tanren-build-real-install-"));
      roots.push(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(join(root, "package.json"), '{"name":"smoke-fixture","private":true}\n');
      await writeFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
      );
      execFileSync("git", ["-C", root, "add", "package.json", "pnpm-lock.yaml"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ]);
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      const ledger = new LifecycleLedger();
      const source = await createCleanBuildContext(
        root,
        head,
        tree,
        process.env,
        ledger,
        (base) => bases.push(base),
        defaultInstallMaterializer,
      );
      // The real frozen-lockfile install materialized a real node_modules in the clean source.
      const nmInfo = await lstat(join(source, "node_modules"));
      expect(nmInfo.isDirectory()).toBe(true);
      expect(nmInfo.isSymbolicLink()).toBe(false);
      // Bootstrap install evidence: cwd is the exact clean source, frozen lockfile + owned store,
      // absolute corepack executable, --prefer-offline (production default), group started+exited,
      // started/finished timestamps, terminal status passed (materialization completed before the
      // source was returned, so the clean coordinator import only occurs after materialization).
      const evidence = ledger.bootstrapInstallEvidence();
      expect(evidence).toBeDefined();
      expect(evidence!.command.cwd).toBe(source);
      expect(evidence!.command.executable).toMatch(/^\//u);
      expect(evidence!.command.executable).not.toBe("corepack");
      expect(evidence!.command.args).toEqual(
        expect.arrayContaining(["install", "--frozen-lockfile", "--prefer-offline"]),
      );
      expect(evidence!.command.args.join(" ")).toMatch(/--store-dir \S+/u);
      expect(evidence!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(evidence!.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(new Date(evidence!.finishedAt!).getTime()).toBeGreaterThanOrEqual(new Date(evidence!.startedAt).getTime());
      expect(evidence!.groupStarted).toBe(true);
      expect(evidence!.groupExited).toBe(true);
      expect(evidence!.status).toBe("passed");
      expect(evidence!.pgid).toBeTypeOf("number");
      // Owned store lives under the build base, never the candidate checkout.
      expect(evidence!.command.args.join(" ")).toContain(join(dirname(source), "cache", "pnpm-store"));
    },
  );

  it(
    "seals failed bootstrap evidence and removes the build base when the lockfile drifts",
    { timeout: PNPM_INSTALL_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "tanren-build-drift-lockfile-"));
      roots.push(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(
        join(root, "package.json"),
        '{"name":"smoke-fixture","private":true,"dependencies":{"express":"^4.0.0"}}\n',
      );
      await writeFile(
        join(root, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
      );
      execFileSync("git", ["-C", root, "add", "package.json", "pnpm-lock.yaml"]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Smoke",
        "-c",
        "user.email=smoke@example.invalid",
        "commit",
        "-qm",
        "drift",
      ]);
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
      const ledger = new LifecycleLedger();
      await expect(
        createCleanBuildContext(root, head, tree, process.env, ledger, (base) => bases.push(base)),
      ).rejects.toThrow(/lockfile|OUTDATED_LOCKFILE/iu);
      // Failed install produces failed bootstrap evidence.
      const evidence = ledger.bootstrapInstallEvidence();
      expect(evidence?.status).toBe("failed");
      expect(evidence?.error).toMatch(/lockfile|OUTDATED_LOCKFILE/iu);
      // No partial source survives a failed install — the build base is safe to remove.
      expect(bases).toHaveLength(1);
      await removeBuildBase(bases[0]);
    },
  );

  it("fails closed on install failure so the coordinator import path is never reached", async () => {
    const root = await repository("install-failure");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    let returnedSource: string | undefined;
    await expect(
      (async () => {
        returnedSource = await createCleanBuildContext(
          root,
          head,
          tree,
          process.env,
          new LifecycleLedger(),
          (base) => bases.push(base),
          failingMaterializer,
        );
      })(),
    ).rejects.toThrow(/synthetic install failure/u);
    expect(returnedSource).toBeUndefined();
  });

  it("aborts a live install child group and seals failed bootstrap evidence with no surviving PGID", async () => {
    const base = await mkdtemp(join(tmpdir(), "tanren-install-abort-"));
    bases.push(base);
    const bin = join(base, "bin");
    await mkdir(bin);
    // Trusted test Corepack shim: stays alive long enough to observe the live group, then is fenced.
    const fakeCorepack = join(bin, "corepack");
    await writeFile(
      fakeCorepack,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e "setInterval(()=>{},3e4)"\n`,
      { mode: 0o755 },
    );
    const source = join(base, "source");
    await mkdir(source);
    await writeFile(join(source, "package.json"), '{"private":true}\n');
    const ledger = new LifecycleLedger();
    const env = {
      ...isolatedInstallEnv(join(base, "home"), join(base, "cache"), join(base, "tmp"), DEFAULT_INSTALL_NETWORK_POLICY),
      PATH: bin,
    };
    const install = defaultInstallMaterializer(
      source,
      env,
      join(base, "store"),
      ledger,
      DEFAULT_INSTALL_NETWORK_POLICY,
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (ledger.bootstrapInstallEvidence()?.groupStarted === true) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(ledger.bootstrapInstallEvidence()?.groupStarted).toBe(true);
    ledger.abort("SIGTERM");
    await expect(install).rejects.toThrow(/aborted|SIGTERM/u);
    const evidence = ledger.bootstrapInstallEvidence();
    expect(evidence?.status).toBe("failed");
    expect(evidence?.groupStarted).toBe(true);
    expect(evidence?.groupExited).toBe(true);
    expect(evidence?.pgid).toBeTypeOf("number");
    expect(processGroupAbsent(evidence!.pgid!)).toBe(true);
    expect(ledger.processGroups.active()).toEqual([]);
  });

  it("supports repeated cleanup of the same build base without error", async () => {
    const root = await repository("cleanup-idempotent");
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const source = await createCleanBuildContext(
      root,
      head,
      tree,
      process.env,
      new LifecycleLedger(),
      (base) => bases.push(base),
      recordingMaterializer([]),
    );
    const base = dirname(source);
    await removeBuildBase(base);
    await expect(removeBuildBase(base)).resolves.toBeUndefined();
  });
});
