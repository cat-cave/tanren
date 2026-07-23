import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubAppIdentity } from "../src/githubApp.js";
import type { CommandExecutor } from "../src/process.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];
const wrongIdentityExecutor: CommandExecutor = async () => ({ stdout: "maintainer-user\n", stderr: "", exitCode: 0 });

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function identityFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cra-identity-"));
  roots.push(root);
  const keyPath = resolve(root, "app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return testConfig({ github: { ...testConfig().github, privateKeyPath: keyPath } });
}

describe("GitHub App identity", () => {
  it("mints a short-lived installation token and verifies the exact bot login", async () => {
    const config = await identityFixture();
    const executor = vi
      .fn<CommandExecutor>()
      .mockResolvedValueOnce({ stdout: "installation-token-with-enough-length\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "trevor-workstation[bot]\n", stderr: "", exitCode: 0 });
    const identity = new GithubAppIdentity(config, executor);
    const token = await identity.mintInstallationToken(new Date("2026-07-22T12:00:00.000Z"));
    await expect(identity.verify(token)).resolves.toBe("trevor-workstation[bot]");
    expect(executor.mock.calls[0]?.[0].args).toContain("POST");
    expect(executor.mock.calls[0]?.[0].args).toContain("/app/installations/456/access_tokens");
    expect(executor.mock.calls[1]?.[0].args.slice(0, 2)).toEqual(["api", "graphql"]);
  });

  it("rejects any authenticated identity other than the configured app", async () => {
    const config = await identityFixture();
    await expect(
      new GithubAppIdentity(config, wrongIdentityExecutor).verify("installation-token-with-enough-length"),
    ).rejects.toThrow("identity mismatch");
  });
});
