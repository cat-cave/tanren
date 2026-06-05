import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildSshExecCommand,
  hostKeyFingerprintMatches,
  normalizeHostKeyFingerprint,
  sshSha256Fingerprint,
  SshCommandSubstrate,
} from "../src/engine/ssh/index.js";

const target: RunnerHandle = {
  backend: "ssh",
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

  it("preserves the fake command substrate", async () => {
    const result = await new FakeCommandSubstrate().run(target, { command: "echo ok", timeoutMs: 100 });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "fake command: echo ok",
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
    const result = await new SshCommandSubstrate(new FakeSecretStore()).run(target, {
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
    const substrate = new SshCommandSubstrate(secrets, { clientFactory: () => client });
    const pinnedTarget: RunnerHandle = { ...target, hostKeyFingerprint: pinned };

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

  it("survives a DOUBLE 'error' emission (pre-handshake loss + teardown re-emit) without crashing", async () => {
    // Regression for a P0: a single transient SSH blip crashed the whole control
    // plane. ssh2 emits "error" once for "Connection lost before handshake" and
    // AGAIN during teardown after settle() calls client.destroy(). A `.once`
    // listener consumes the first emission, leaving the second with no listener,
    // so Node's EventEmitter throws an unhandled "error" → exit(1). With a
    // persistent `.on` listener the second emission is swallowed by the settled
    // guard. If this regresses, the second emit below throws inside the test
    // (unhandled "error" on an EventEmitter) and the test fails/crashes.
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: target.identitySecretRef, value: "private-key" });

    // The fake destroy() re-emits "error" exactly as ssh2 does during teardown.
    const { client, state } = createDoubleErrorClient();
    const substrate = new SshCommandSubstrate(secrets, { clientFactory: () => client });

    // The fake's connect() emits the pre-handshake error, which drives
    // settle() → destroy() → a SECOND "error" emission during teardown.
    const result = await substrate.run(target, { command: "echo ok", timeoutMs: 100 });

    // Settles exactly once, to a single ssh_failed CommandResult — the first
    // error's message wins; the teardown re-emit is a no-op.
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.failure?.kind).toBe("ssh_failed");
    expect(result.failure?.message).toBe("Connection lost before handshake");
    // settle() ran exactly once → exactly one destroy(); the teardown re-emit it
    // triggered did not loop back into a second settle.
    expect(state.destroyCount).toBe(1);
  });

  it("returns ssh_failed with captured output when stdin end triggers a channel error", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
    const { client, state } = createChannelErrorClient();
    const substrate = new SshCommandSubstrate(secrets, { clientFactory: () => client });

    const result = await substrate.run(target, {
      command: "cat",
      stdin: "input",
      timeoutMs: 100,
    });

    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("stdout before error");
    expect(result.stderr).toBe("stderr before error");
    expect(result.timedOut).toBe(false);
    expect(result.failure).toEqual({
      kind: "ssh_failed",
      target: "tanren@runner:22",
      message: "channel read failed",
    });
    expect(state.destroyCount).toBe(1);
    expect(state.stdinWritten).toBe("input");
  });

  it("returns ssh_failed with timedOut when the SSH operation exceeds the command timeout", async () => {
    vi.useFakeTimers();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: target.identitySecretRef, value: "private-key" });
    const client = createNeverReadyClient();
    const substrate = new SshCommandSubstrate(secrets, { clientFactory: () => client });

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

function createChannelErrorClient(): {
  client: Client & EventEmitter;
  state: { destroyCount: number; stdinWritten: string };
} {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const state = { destroyCount: 0, stdinWritten: "" };
  const stream = Object.assign(new EventEmitter(), {
    stderr,
    end: (chunk?: string | Buffer) => {
      state.stdinWritten += chunk?.toString() ?? "";
      stream.emit("data", Buffer.from("stdout before error"));
      stderr.emit("data", Buffer.from("stderr before error"));
      stream.emit("error", new Error("channel read failed"));
      return stream;
    },
  });
  const client = Object.assign(emitter, {
    connect: () => {
      queueMicrotask(() => emitter.emit("ready"));
      return client;
    },
    destroy: () => {
      state.destroyCount += 1;
      return client;
    },
    end: () => client,
    exec: (_command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
      callback(noExecError(), stream as unknown as ClientChannel);
      return client;
    },
  });
  return {
    client: client as unknown as Client & EventEmitter,
    state,
  };
}

function noExecError(): Error | undefined {}

/**
 * A fake ssh2 Client whose `destroy()` re-emits "error" — reproducing ssh2's
 * real teardown behaviour after a pre-handshake connection loss. The first
 * "error" the test emits drives settle() → destroy(), which fires a SECOND
 * "error". We deliberately attach NO counting listener of our own: the
 * substrate's production listener must be the only one. That way, if the fix
 * regressed to `.once`, the second emit would find no listener and Node's
 * EventEmitter would THROW an unhandled "error" — surfacing the crash inside the
 * test. `destroyCount` is tracked via the method override (not a listener).
 */
function createDoubleErrorClient(): { client: Client & EventEmitter; state: { destroyCount: number } } {
  const emitter = new EventEmitter();
  const state = { destroyCount: 0 };
  const client = Object.assign(emitter, {
    connect: () => {
      // Emit the pre-handshake loss AFTER the substrate has attached its
      // listeners (connect() is called synchronously after they are wired).
      queueMicrotask(() => emitter.emit("error", new Error("Connection lost before handshake")));
      return client;
    },
    destroy: () => {
      state.destroyCount += 1;
      // ssh2 emits "error" again during teardown after a pre-handshake loss.
      // With `.once` in production this second emit has no listener → throws.
      emitter.emit("error", new Error("read ECONNRESET"));
      return client;
    },
    end: () => client,
    exec: () => client,
  });
  return { client: client as unknown as Client & EventEmitter, state };
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
