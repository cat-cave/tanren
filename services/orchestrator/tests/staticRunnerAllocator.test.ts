import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { StaticRunnerAllocator } from "../src/engine/allocators/staticRunnerAllocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";

class FakeRunnerStore implements RunnerStore {
  readonly claims: ClaimRunnerInput[] = [];
  readonly releases: string[] = [];

  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claims.push(input);
  }
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

interface FakeClientOptions {
  fingerprint?: string;
  emitError?: boolean;
}

// The exact ssh2 connect config the discovery handshake builds. Captured so a
// test can assert the host-key-only handshake parameters (username, hostHash,
// and that hostVerifier rejects the connection) — these are distinct mutation
// survivors the type-only checks above cannot reach.
interface CapturedConnect {
  config?: {
    host?: string;
    port?: number;
    username?: string;
    hostHash?: string;
    hostVerifier?: (fingerprint: string) => boolean;
  };
}

function fakeClientFactory(opts: FakeClientOptions, captured?: CapturedConnect) {
  return () => {
    const emitter = new EventEmitter();
    return {
      once: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.once(event, handler);
        return emitter;
      },
      connect: (config: NonNullable<CapturedConnect["config"]>) => {
        if (captured) {
          captured.config = config;
        }
        // Simulate ssh2: hostVerifier is invoked, then connection is aborted
        // (since we return false) and an "error" event follows.
        queueMicrotask(() => {
          if (opts.fingerprint !== undefined) {
            config.hostVerifier?.(opts.fingerprint);
          }
          if (opts.emitError ?? true) {
            emitter.emit("error", new Error("Handshake failed: host key verification failed"));
          }
        });
        return emitter;
      },
      destroy: () => {},
      end: () => {},
    };
  };
}

describe("StaticRunnerAllocator", () => {
  it("uses a pre-known fingerprint and mirrors the runner row", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      hostKeyFingerprint: "SHA256:precooked",
      runners,
    });

    const allocation = await allocator.allocate({
      runId: "run_abc",
      projectId: "proj_abc",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/dev/identity",
    });

    expect(allocation.runnerId).toBe("runner_run_abc");
    expect(allocation.target.host).toBe("runner");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:precooked");
    expect(allocation.target.identitySecretRef).toBe("runner/dev/identity");
    expect(runners.claims).toHaveLength(1);
    expect(runners.claims[0]?.allocator).toBe("static-runner");
    expect(runners.claims[0]?.hostKeyFingerprint).toBe("SHA256:precooked");
  });

  it("discovers the host key via TOFU when no fingerprint is configured", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: fakeClientFactory({
        // ssh2 hashes the wire-format host key; with hostHash: "sha256" the
        // hex-encoded digest is passed to hostVerifier. The exact bytes do
        // not matter for this test — only that the normalizer round-trips it.
        fingerprint: "a".repeat(64),
      }),
    });

    const allocation = await allocator.allocate({
      runId: "run_tofu",
      projectId: "proj_tofu",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/dev/identity",
    });

    // The captured hex fingerprint is normalized to SHA256:<base64-no-pad>.
    // Pin the exact value so the hex->base64 conversion + "=" padding strip
    // are behavior-asserted, not just the prefix.
    const expected = "SHA256:" + Buffer.from("a".repeat(64), "hex").toString("base64").replace(/=+$/, "");
    expect(allocation.target.hostKeyFingerprint).toBe(expected);
    expect(expected).not.toMatch(/=$/);
    expect(allocation.imageSha).toBe("ghcr.io/cat-cave/tanren-runner:v0@sha256:static");
    expect(runners.claims).toHaveLength(1);
    expect(runners.claims[0]?.hostKeyFingerprint).toBe(expected);
  });

  it("opens the discovery handshake to the configured host with a host-key-only ssh2 config", async () => {
    const captured: CapturedConnect = {};
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "10.0.0.7",
      port: 2222,
      runners,
      clientFactory: fakeClientFactory({ fingerprint: "b".repeat(64) }, captured),
    });

    await allocator.allocate({
      runId: "run_cfg",
      projectId: "p",
      runnerImage: "img",
      identitySecretRef: "runner/dev/identity",
    });

    // The discovery connect must target the configured host/port.
    expect(captured.config?.host).toBe("10.0.0.7");
    expect(captured.config?.port).toBe(2222);
    // It is a host-key-only handshake: ssh2 is told to SHA256-hash the key and
    // authenticates as "tanren" (no identity is offered — the handshake aborts
    // after the key is captured).
    expect(captured.config?.username).toBe("tanren");
    expect(captured.config?.hostHash).toBe("sha256");
    // The verifier must REJECT the connection (return false): we only needed
    // the fingerprint, so the handshake is intentionally torn down.
    expect(typeof captured.config?.hostVerifier).toBe("function");
    expect(captured.config?.hostVerifier?.("b".repeat(64))).toBe(false);
  });

  it("rejects when discovery completes without ever capturing a fingerprint", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      // No fingerprint captured, but also no error emitted by connect: force
      // the discovery timeout path so the "completed without a fingerprint" /
      // timeout rejection fires instead of resolving.
      discoverTimeoutMs: 5,
      clientFactory: fakeClientFactory({ fingerprint: undefined, emitError: false }),
    });

    await expect(
      allocator.allocate({
        runId: "run_to",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/timed out/);
    expect(runners.claims).toEqual([]);
  });

  it("rejects when the SSH handshake errors before a fingerprint is captured", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: fakeClientFactory({ fingerprint: undefined, emitError: true }),
    });

    await expect(
      allocator.allocate({
        runId: "run_err",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/host key discovery failed/);
  });

  it("rejects when the captured host key cannot be parsed into a fingerprint", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      // ssh2 hands back a value the fingerprint normalizer cannot decode (not
      // 64-hex, not a valid SHA256:<base64>); discovery must reject with the
      // "unparseable fingerprint" error rather than claim a runner.
      clientFactory: fakeClientFactory({ fingerprint: "not-a-real-fingerprint" }),
    });

    await expect(
      allocator.allocate({
        runId: "run_bad_fp",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/unparseable fingerprint/);
    expect(runners.claims).toEqual([]);
  });

  it("releases by clearing the orchestrator mirror row only", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      hostKeyFingerprint: "SHA256:test",
      runners,
    });

    await allocator.release("runner_run_xyz", "completed");
    expect(runners.releases).toEqual(["runner_run_xyz"]);
  });
});
