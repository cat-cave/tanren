import { readFile } from "node:fs/promises";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../src/engine/ssh/index.js";

const runIntegration = process.env.TANREN_SSH_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("SSH substrate live runner integration", () => {
  it("runs success and nonzero commands over ssh2 exec", async () => {
    const keyPath = requiredEnv("TANREN_SSH_KEY_PATH");
    const hostFingerprint = requiredEnv("TANREN_SSH_HOST_FINGERPRINT");
    const secrets = new FakeSecretStore();
    await secrets.put({
      ref: "runner/integration/identity",
      value: await readFile(keyPath, "utf8"),
    });

    const substrate = new SshCommandSubstrate(secrets, {
      serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS),
    });
    const target: RunnerHandle = {
      backend: "ssh",
      host: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
      port: Number(process.env.TANREN_SSH_PORT ?? "22"),
      username: process.env.TANREN_SSH_USER ?? "tanren",
      hostKeyFingerprint: hostFingerprint,
      identitySecretRef: "runner/integration/identity",
    };

    const success = await substrate.run(target, { command: "printf 'ok'" });
    const nonzero = await substrate.run(target, {
      command: "printf 'err' >&2; exit 7",
    });
    const cwd = await substrate.run(target, {
      command: "pwd",
      cwd: "/workspace",
    });

    expect(success).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(success.stalled).toBeFalsy();
    expect(success.failure).toBeUndefined();
    expect(nonzero).toMatchObject({ exitCode: 7, stdout: "", stderr: "err" });
    expect(nonzero.stalled).toBeFalsy();
    expect(nonzero.failure).toBeUndefined();
    expect(cwd).toMatchObject({ exitCode: 0, stdout: "/workspace\n", stderr: "" });
    expect(cwd.stalled).toBeFalsy();
    expect(cwd.failure).toBeUndefined();
  });
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when TANREN_SSH_INTEGRATION=1`);
  }
  return value;
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}
