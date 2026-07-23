import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveCraPaths } from "../src/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cra-config-"));
  temporaryDirectories.push(root);
  const repositoryRoot = resolve(root, "repo");
  const configDirectory = resolve(root, "config");
  const keyPath = resolve(root, "credentials", "app.pem");
  await mkdir(repositoryRoot);
  await mkdir(configDirectory);
  await mkdir(resolve(root, "credentials"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const configPath = resolve(configDirectory, "cra.json");
  const config = {
    repository: "cat-cave/tanren",
    repositoryRoot,
    rubricVersion: "2026-07-22",
    github: { appId: 1, installationId: 2, expectedLogin: "trevor-workstation[bot]", privateKeyPath: keyPath },
    isolation: { worktreeRoot: resolve(root, "worktrees"), image: "cra-audit:latest" },
  };
  return { root, repositoryRoot, keyPath, configPath, config };
}

describe("CRA configuration and paths", () => {
  it("resolves all mutable state beneath XDG state and outside the repository", async () => {
    const value = await fixture();
    await writeFile(value.configPath, JSON.stringify(value.config));
    const loaded = await loadConfig(value.configPath, {
      HOME: value.root,
      XDG_STATE_HOME: resolve(value.root, "state"),
      XDG_CONFIG_HOME: resolve(value.root, "xdg-config"),
    });
    expect(loaded.paths.stateRoot).toBe(resolve(value.root, "state/tanren-cra/cat-cave-tanren"));
    expect(loaded.paths.stateRoot.startsWith(value.repositoryRoot)).toBe(false);
    expect(loaded.config.commands.gh).toBe("gh");
  });

  it("rejects a private key exposed to group or other users", async () => {
    const value = await fixture();
    await chmod(value.keyPath, 0o644);
    await writeFile(value.configPath, JSON.stringify(value.config));
    await expect(
      loadConfig(value.configPath, { HOME: value.root, XDG_STATE_HOME: resolve(value.root, "state") }),
    ).rejects.toThrow("must not grant group or other permissions");
  });

  it("rejects a state root placed inside the repository", async () => {
    const value = await fixture();
    await writeFile(value.configPath, JSON.stringify(value.config));
    await expect(
      loadConfig(value.configPath, { HOME: value.root, XDG_STATE_HOME: resolve(value.repositoryRoot, ".state") }),
    ).rejects.toThrow("CRA state must be outside");
  });

  it("requires absolute XDG roots", () => {
    expect(() => resolveCraPaths("cat-cave/tanren", { HOME: "/tmp", XDG_STATE_HOME: "relative" })).toThrow("absolute");
  });
});
