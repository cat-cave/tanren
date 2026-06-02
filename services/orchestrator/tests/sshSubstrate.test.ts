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

  it("pins the host key: the hostVerifier ACCEPTS the matching fingerprint and REJECTS a mismatch", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: target.identitySecretRef, value: "private-key" });

    // Generate a real ed25519 host key, pin its fingerprint, and confirm the
    // substrate's hostVerifier accepts the SHA256 the server would present and
    // rejects a different key's SHA256 — no blind trust.
    const { utils } = await import("ssh2");
    const hostKey = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(hostKey.public);
    if (parsed instanceof Error) {
      throw parsed;
    }
    const pinned = sshSha256Fingerprint(parsed.getPublicSSH());
    // With `hostHash: "sha256"`, ssh2 hands the verifier the HEX digest of the
    // server's public-SSH blob (see ssh2 client.js). Reproduce that exact input.
    const presented = createHash("sha256").update(parsed.getPublicSSH()).digest("hex");
    const otherKey = utils.parseKey(utils.generateKeyPairSync("ed25519").public);
    if (otherKey instanceof Error) {
      throw otherKey;
    }
    const mismatch = createHash("sha256").update(otherKey.getPublicSSH()).digest("hex");

    const { client, capture } = createCaptureClient();
    const substrate = new Ssh2Substrate(secrets, { clientFactory: () => client });
    const pinnedTarget: SshTarget = { ...target, hostKeyFingerprint: pinned };

    // Drive a run; the substrate calls client.connect with a hostVerifier we capture.
    const runPromise = substrate.run(pinnedTarget, { command: "echo ok", timeoutMs: 100 });
    const verifier = await capture;

    // The verifier receives the bare base64 (no SHA256: prefix); both forms are
    // normalized. Matching key -> accepted; different key -> rejected.
    expect(verifier(presented)).toBe(true);
    expect(verifier(mismatch)).toBe(false);

    // Settle the run so the promise resolves (the fake never authenticates).
    client.emit("error", new Error("done"));
    const result = await runPromise;
    expect(result.failure?.kind).toBe("ssh_failed");
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

type HostVerifier = (fingerprint: string) => boolean;

/**
 * A fake ssh2 Client that captures the `hostVerifier` passed to `connect()` so a
 * test can invoke it directly and assert accept/reject. Never authenticates.
 */
function createCaptureClient(): { client: Client & EventEmitter; capture: Promise<HostVerifier> } {
  const emitter = new EventEmitter();
  let resolveVerifier: (v: HostVerifier) => void;
  const capture = new Promise<HostVerifier>((resolve) => {
    resolveVerifier = resolve;
  });
  const client = Object.assign(emitter, {
    connect: (config: { hostVerifier?: HostVerifier }) => {
      if (config.hostVerifier !== undefined) {
        resolveVerifier(config.hostVerifier);
      }
      return client;
    },
    destroy: () => client,
    end: () => client,
    exec: () => client,
  });
  return { client: client as unknown as Client & EventEmitter, capture };
}
