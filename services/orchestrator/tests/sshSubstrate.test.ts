import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeSshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  buildSshExecCommand,
  hostKeyFingerprintMatches,
  normalizeHostKeyFingerprint,
  sshSha256Fingerprint,
  Ssh2Substrate,
} from "../src/engine/ssh/index.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  identitySecretRef: "runner/run_1/identity",
};

describe("SSH substrate contract", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the fake SSH substrate", async () => {
    const result = await new FakeSshSubstrate().run(target, { command: "echo ok", timeoutMs: 100 });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "fake ssh: echo ok",
      stderr: "",
      timedOut: false,
    });
  });

  it("wraps commands with safely quoted cwd", () => {
    expect(buildSshExecCommand({ command: "pwd", timeoutMs: 100 })).toBe("pwd");
    expect(
      buildSshExecCommand({
        command: "pwd",
        cwd: "/work/path with spaces/it's fine",
        timeoutMs: 100,
      }),
    ).toBe("cd '/work/path with spaces/it'\\''s fine' && pwd");
    expect(() => buildSshExecCommand({ command: "pwd", cwd: "bad\0path", timeoutMs: 100 })).toThrow("null byte");
  });

  it("normalizes OpenSSH and hex SHA-256 host key fingerprints", () => {
    const key = Buffer.from("tanren-runner-host-key");
    const hex = createHash("sha256").update(key).digest("hex");
    const openssh = sshSha256Fingerprint(key);
    const colonHex = hex.match(/.{2}/gu)?.join(":") ?? "";

    expect(normalizeHostKeyFingerprint(openssh)).toBe(hex);
    expect(normalizeHostKeyFingerprint(hex.toUpperCase())).toBe(hex);
    expect(normalizeHostKeyFingerprint(colonHex)).toBe(hex);
    expect(hostKeyFingerprintMatches(openssh, hex)).toBe(true);
    expect(hostKeyFingerprintMatches(openssh, target.hostKeyFingerprint)).toBe(false);
  });

  it("returns ssh_failed when the identity secret is missing", async () => {
    const result = await new Ssh2Substrate(new FakeSecretStore()).run(target, {
      command: "echo ok",
      timeoutMs: 100,
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.failure).toEqual({
      kind: "ssh_failed",
      target: "tanren@runner:22",
      message: "missing SSH identity secret: runner/run_1/identity",
    });
  });

  it("returns ssh_failed with timedOut when the SSH operation exceeds the command timeout", async () => {
    vi.useFakeTimers();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
    const client = createNeverReadyClient();
    const substrate = new Ssh2Substrate(secrets, { clientFactory: () => client });

    const resultPromise = substrate.run(target, { command: "sleep 10", timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.failure?.kind).toBe("ssh_failed");
    expect(result.failure?.message).toBe("SSH command timed out after 25ms");
  });
});

function createNeverReadyClient(): Client {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: () => client,
    destroy: () => client,
    end: () => client,
    exec: () => client,
  });
  return client as unknown as Client;
}
