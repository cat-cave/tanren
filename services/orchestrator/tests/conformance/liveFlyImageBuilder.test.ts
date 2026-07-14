// liveFlyImageBuilder (PR3) — the LIVE Fly image-builder driver exercised against injected
// fakes (NO docker / NO GitHub / NO network). Mirrors how `flyImageBuilder.test.ts` pins
// the SEAM; this file pins the LIVE driver's wiring: it mints a GitHub token for the
// repo, fetches the merged tarball with it, shells build-deploy-image.sh with
// APP/SHA/FLY_TOKEN/CONTEXT, parses the pushed ref, throws FlyImageBuildFailedError on a
// non-zero exit, and NEVER places a token in an error. Plus the config reader's
// no-silent-fallback doctrine (fail loud when opted in but a dep is missing).

import { afterEach, describe, expect, it } from "vitest";
import {
  buildLiveFlyImageBuilder,
  githubTarballUrl,
  type LiveFlyImageBuilderDeps,
} from "../../src/engine/provisioners/liveFlyImageBuilder.js";
import { FlyImageBuildFailedError, type FlyImageBuildRequest } from "../../src/engine/provisioners/flyImageBuilder.js";
import {
  buildFlyImageBuilderFromEnv,
  flyImageBuilderConfigured,
  FlyImageBuilderConfigError,
} from "../../src/engine/provisioners/flyImageBuilderConfig.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { GithubAppTokenMinter } from "../../src/engine/providers/githubAppTokenMinter.js";
import { DOCKERIGNORE, dockerfileFor } from "../../src/engine/templates/fragments/library/addon-docker.js";

const FLY_TOKEN = "fly_secret_registry_token";
const SOURCE_TOKEN = "ghs_fake_installation_token";

const REQUEST: FlyImageBuildRequest = {
  repo: "acme/web",
  ref: "abc123def",
  appName: "tanren-acme-web",
  flyToken: FLY_TOKEN,
};

interface FakeCalls {
  mintRepos: string[];
  fetchCalls: Array<{ url: string; token: string }>;
  execCalls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
  writes: Array<{ path: string; content: string }>;
  removedDirs: string[];
}

/**
 * Build fake deps over an in-memory context. `contextFiles` is the set of paths the
 * extracted build context "contains" (basenames under `/fake/tmp-buildctx`) — it drives
 * both the "does the repo already have a Dockerfile?" check and runtime detection. A write
 * into the context adds to the set (so a generated Dockerfile is then "present").
 */
function fakeLiveDeps(
  overrides?: Partial<LiveFlyImageBuilderDeps>,
  contextFiles: readonly string[] = ["Dockerfile"],
): {
  deps: LiveFlyImageBuilderDeps;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    mintRepos: [],
    fetchCalls: [],
    execCalls: [],
    writes: [],
    removedDirs: [],
  };
  const present = new Set(contextFiles.map((f) => `/fake/tmp-buildctx/${f}`));
  const deps: LiveFlyImageBuilderDeps = {
    scriptPath: "/fake/build-deploy-image.sh",
    mintSourceToken: async (repo) => {
      calls.mintRepos.push(repo);
      return SOURCE_TOKEN;
    },
    fetchTarball: async (url, token) => {
      calls.fetchCalls.push({ url, token });
      return new Uint8Array([0, 1, 2]);
    },
    extractTarball: async () => {},
    execFile: async (file, args, options) => {
      calls.execCalls.push({ file, args, env: options.env });
      return { stdout: "[build-deploy-image] built + pushed\nregistry.fly.io/tanren-acme-web:abc123def" };
    },
    makeTempDir: async () => "/fake/tmp-buildctx",
    fileExists: async (path) => present.has(path),
    writeContextFile: async (path, content) => {
      calls.writes.push({ path, content });
      present.add(path);
    },
    removeDir: async (dir) => {
      calls.removedDirs.push(dir);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("liveFlyImageBuilder — the live Fly image-build driver", () => {
  it("(a) mints a GitHub token for the merged repo", async () => {
    const { deps, calls } = fakeLiveDeps();
    const builder = buildLiveFlyImageBuilder(deps);
    await builder.build(REQUEST);
    expect(calls.mintRepos).toEqual(["acme/web"]);
  });

  it("(b) fetches /repos/{owner}/{repo}/tarball/{sha} with the minted token", async () => {
    const { deps, calls } = fakeLiveDeps();
    const builder = buildLiveFlyImageBuilder(deps);
    await builder.build(REQUEST);
    expect(calls.fetchCalls).toHaveLength(1);
    expect(calls.fetchCalls[0]!.url).toBe(githubTarballUrl("acme/web", "abc123def"));
    // The minted token is the bearer — NEVER the Fly token.
    expect(calls.fetchCalls[0]!.token).toBe(SOURCE_TOKEN);
    expect(calls.fetchCalls[0]!.token).not.toBe(FLY_TOKEN);
  });

  it("(c) invokes the build script via the exec seam with APP/SHA/FLY_TOKEN/CONTEXT set", async () => {
    const { deps, calls } = fakeLiveDeps();
    const builder = buildLiveFlyImageBuilder(deps);
    await builder.build(REQUEST);
    expect(calls.execCalls).toHaveLength(1);
    expect(calls.execCalls[0]!.file).toBe("bash");
    expect(calls.execCalls[0]!.args).toEqual(["/fake/build-deploy-image.sh"]);
    const env = calls.execCalls[0]!.env;
    expect(env["APP"]).toBe("tanren-acme-web");
    expect(env["SHA"]).toBe("abc123def");
    expect(env["FLY_TOKEN"]).toBe(FLY_TOKEN);
    expect(env["CONTEXT"]).toBe("/fake/tmp-buildctx");
  });

  it("(d) returns the parsed pushed image ref from the script's last stdout line", async () => {
    const { deps } = fakeLiveDeps();
    const builder = buildLiveFlyImageBuilder(deps);
    const result = await builder.build(REQUEST);
    expect(result.imageRef).toBe("registry.fly.io/tanren-acme-web:abc123def");
  });

  it("(e) throws FlyImageBuildFailedError on a non-zero script exit", async () => {
    const { deps } = fakeLiveDeps({
      execFile: async () => {
        throw new Error("Command failed: bash build-deploy-image.sh (exit code 1)");
      },
    });
    const builder = buildLiveFlyImageBuilder(deps);
    await expect(builder.build(REQUEST)).rejects.toBeInstanceOf(FlyImageBuildFailedError);
  });

  it("(f) NEVER places the Fly token in the thrown error (even when the cause echoed it)", async () => {
    // A pathological cause that somehow contains the token — the driver MUST redact it.
    const { deps } = fakeLiveDeps({
      execFile: async () => {
        throw new Error(`docker login leaked token=${FLY_TOKEN} in stderr`);
      },
    });
    const builder = buildLiveFlyImageBuilder(deps);
    let caught: unknown;
    try {
      await builder.build(REQUEST);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlyImageBuildFailedError);
    // The token is NEVER in the message; the app + ref ARE (diagnostic coordinates).
    expect((caught as Error).message).not.toContain(FLY_TOKEN);
    expect((caught as Error).message).toContain("tanren-acme-web");
    expect((caught as Error).message).toContain("abc123def");
  });

  it("cleans up the temp build-context dir (even on failure)", async () => {
    const { deps, calls } = fakeLiveDeps({
      execFile: async () => {
        throw new Error("exit 1");
      },
    });
    const builder = buildLiveFlyImageBuilder(deps);
    await expect(builder.build(REQUEST)).rejects.toBeInstanceOf(FlyImageBuildFailedError);
    expect(calls.removedDirs).toEqual(["/fake/tmp-buildctx"]);
  });

  it("fails loud when the build script produces no registry ref on its last line", async () => {
    const { deps } = fakeLiveDeps({
      execFile: async () => ({ stdout: "[build] something went wrong\nno-ref-here" }),
    });
    const builder = buildLiveFlyImageBuilder(deps);
    await expect(builder.build(REQUEST)).rejects.toBeInstanceOf(FlyImageBuildFailedError);
  });
});

describe("liveFlyImageBuilder — ensure a Dockerfile is present (generate one when the repo lacks it)", () => {
  const DOCKERFILE_PATH = "/fake/tmp-buildctx/Dockerfile";
  const DOCKERIGNORE_PATH = "/fake/tmp-buildctx/.dockerignore";

  it("(a) leaves a product-authored Dockerfile untouched (does NOT overwrite it)", async () => {
    // Context already carries a Dockerfile — the product owns its build recipe.
    const { deps, calls } = fakeLiveDeps(undefined, ["Dockerfile", "package.json"]);
    const builder = buildLiveFlyImageBuilder(deps);
    await builder.build(REQUEST);
    // Nothing written into the context; the build proceeds over the existing Dockerfile.
    expect(calls.writes).toEqual([]);
    expect(calls.execCalls).toHaveLength(1);
  });

  it("(b) generates dockerfileFor(runtime) + .dockerignore when the repo has none, then builds", async () => {
    // A ts/pnpm scaffold that authored NO Dockerfile (only package.json).
    const { deps, calls } = fakeLiveDeps(undefined, ["package.json"]);
    const builder = buildLiveFlyImageBuilder(deps);
    const result = await builder.build(REQUEST);
    // Both files were written into the context with the SAME bytes addon-docker emits.
    const paths = calls.writes.map((w) => w.path);
    expect(paths).toContain(DOCKERFILE_PATH);
    expect(paths).toContain(DOCKERIGNORE_PATH);
    expect(calls.writes.find((w) => w.path === DOCKERFILE_PATH)?.content).toBe(dockerfileFor("node-pnpm"));
    expect(calls.writes.find((w) => w.path === DOCKERIGNORE_PATH)?.content).toBe(DOCKERIGNORE);
    // The build still proceeds and returns the pushed ref.
    expect(calls.execCalls).toHaveLength(1);
    expect(result.imageRef).toBe("registry.fly.io/tanren-acme-web:abc123def");
  });

  it("(c) detects the runtime from context manifests (node-pnpm vs ruby-bundler vs python/go/rust)", async () => {
    const cases: Array<{ files: string[]; runtime: Parameters<typeof dockerfileFor>[0] }> = [
      { files: ["package.json"], runtime: "node-pnpm" },
      { files: ["Gemfile"], runtime: "ruby-bundler" },
      { files: ["pyproject.toml"], runtime: "python" },
      { files: ["requirements.txt"], runtime: "python" },
      { files: ["go.mod"], runtime: "go-modules" },
      { files: ["Cargo.toml"], runtime: "rust-cargo" },
    ];
    for (const { files, runtime } of cases) {
      const { deps, calls } = fakeLiveDeps(undefined, files);
      const builder = buildLiveFlyImageBuilder(deps);
      await builder.build(REQUEST);
      expect(calls.writes.find((w) => w.path === DOCKERFILE_PATH)?.content).toBe(dockerfileFor(runtime));
    }
  });

  it("(c') a package.json wins over a lower-preference marker (node recipe, not python)", async () => {
    const { deps, calls } = fakeLiveDeps(undefined, ["package.json", "requirements.txt"]);
    const builder = buildLiveFlyImageBuilder(deps);
    await builder.build(REQUEST);
    expect(calls.writes.find((w) => w.path === DOCKERFILE_PATH)?.content).toBe(dockerfileFor("node-pnpm"));
  });

  it("(d) throws FlyImageBuildFailedError (naming app + ref, no token) when the runtime is undetectable", async () => {
    // No Dockerfile and no recognized manifest — a LOUD halt, never a wrong-runtime guess.
    const { deps, calls } = fakeLiveDeps(undefined, ["README.md"]);
    const builder = buildLiveFlyImageBuilder(deps);
    let caught: unknown;
    try {
      await builder.build(REQUEST);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlyImageBuildFailedError);
    expect((caught as Error).message).toContain("tanren-acme-web");
    expect((caught as Error).message).toContain("abc123def");
    expect((caught as Error).message).not.toContain(FLY_TOKEN);
    expect((caught as Error).message).not.toContain(SOURCE_TOKEN);
    // Undetectable → never shells the build script; temp dir still cleaned up.
    expect(calls.execCalls).toEqual([]);
    expect(calls.removedDirs).toEqual(["/fake/tmp-buildctx"]);
  });
});

// --- config reader: no-silent-fallback doctrine ---

const ENV_KEYS = ["TANREN_FLY_IMAGE_BUILDER", "TANREN_GITHUB_APP_CREDENTIAL_REF", "TANREN_FLY_BUILD_SCRIPT"];
const savedEnv: Record<string, string | undefined> = {};

describe("buildFlyImageBuilderFromEnv — no-silent-fallback", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
      delete savedEnv[key];
    }
  });

  function setEnv(key: string, value: string | undefined): void {
    if (savedEnv[key] === undefined) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("returns undefined when not opted in (legitimate off; triggerDeploy fail-loud per-provider)", () => {
    setEnv("TANREN_FLY_IMAGE_BUILDER", undefined);
    expect(flyImageBuilderConfigured()).toBe(false);
    expect(buildFlyImageBuilderFromEnv({ secrets: new InMemorySecretStore() })).toBeUndefined();
  });

  it("fails loud (FlyImageBuilderConfigError) when opted in but no App minter is wired", () => {
    setEnv("TANREN_FLY_IMAGE_BUILDER", "1");
    setEnv("TANREN_GITHUB_APP_CREDENTIAL_REF", "credential/github_app/test");
    expect(() => buildFlyImageBuilderFromEnv({ secrets: new InMemorySecretStore() })).toThrow(
      FlyImageBuilderConfigError,
    );
  });

  it("fails loud when opted in but TANREN_GITHUB_APP_CREDENTIAL_REF is unset", () => {
    setEnv("TANREN_FLY_IMAGE_BUILDER", "1");
    setEnv("TANREN_GITHUB_APP_CREDENTIAL_REF", undefined);
    const minter = new GithubAppTokenMinter({ secrets: new InMemorySecretStore() });
    expect(() => buildFlyImageBuilderFromEnv({ secrets: new InMemorySecretStore(), githubAppMinter: minter })).toThrow(
      FlyImageBuilderConfigError,
    );
  });

  it("constructs a builder when opted in and all deps are present", () => {
    setEnv("TANREN_FLY_IMAGE_BUILDER", "1");
    setEnv("TANREN_GITHUB_APP_CREDENTIAL_REF", "credential/github_app/test");
    const minter = new GithubAppTokenMinter({ secrets: new InMemorySecretStore() });
    const builder = buildFlyImageBuilderFromEnv({
      secrets: new InMemorySecretStore(),
      githubAppMinter: minter,
    });
    expect(builder).toBeDefined();
    expect(typeof builder?.build).toBe("function");
  });
});
