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
  /**
   * Re-emit "error" during destroy() to reproduce ssh2's teardown behaviour
   * after a pre-handshake connection loss. With a `.once` error listener the
   * second emission has no listener and Node's EventEmitter throws → crash.
   */
  doubleEmitOnDestroy?: boolean;
  /**
   * Emit a TRANSIENT socket reset ("read ECONNRESET") as the handshake error instead of
   * the default non-transient host-key-verification failure. Used to drive the Part A
   * transient-retry path (a momentary network blip mid-handshake).
   */
  transientReset?: boolean;
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
    const client = {
      // The allocator now registers the error listener with `.on` (persistent),
      // not `.once`, so the teardown re-emit is swallowed instead of crashing.
      // The fake must proxy `.on` to actually receive it.
      on: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
        return emitter;
      },
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
            emitter.emit(
              "error",
              new Error(
                opts.transientReset === true ? "read ECONNRESET" : "Handshake failed: host key verification failed",
              ),
            );
          }
        });
        return emitter;
      },
      destroy: () => {
        if (opts.doubleEmitOnDestroy ?? false) {
          // ssh2 re-emits "error" during teardown after a pre-handshake loss.
          // Real ssh2 fires this on a LATER tick, so it escapes the try/catch
          // around destroy() in settle(). With `.once` this second emission has
          // no listener and Node's EventEmitter throws → unhandled crash.
          queueMicrotask(() => emitter.emit("error", new Error("read ECONNRESET")));
        }
      },
      end: () => {},
    };
    return client;
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
    const expected = "SHA256:" + Buffer.from("a".repeat(64), "hex").toString("base64").replace(/=+$/u, "");
    expect(allocation.target.hostKeyFingerprint).toBe(expected);
    expect(expected).not.toMatch(/=$/u);
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
    ).rejects.toThrow(/timed out/u);
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
    ).rejects.toThrow(/host key discovery failed/u);
  });

  it("survives a DOUBLE 'error' emission during discovery teardown without crashing", async () => {
    // Regression for a P0: a single pre-handshake SSH blip crashed the whole
    // control plane. ssh2 emits "error" once for the failed handshake and AGAIN
    // during teardown after settle() calls client.destroy(). A `.once` listener
    // consumes the first emission, leaving the second with no listener, so Node's
    // EventEmitter throws an unhandled "error" → exit(1). With a persistent `.on`
    // listener the second emission hits the `settled` guard and is a no-op. If
    // this regresses, the destroy()-triggered re-emit throws inside the test.
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: fakeClientFactory({
        fingerprint: undefined,
        emitError: true,
        doubleEmitOnDestroy: true,
      }),
    });

    // Rejects exactly once with the discovery-failed error; the teardown re-emit
    // does not crash the process and does not re-reject.
    await expect(
      allocator.allocate({
        runId: "run_double_err",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/host key discovery failed/u);
    expect(runners.claims).toEqual([]);
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
    ).rejects.toThrow(/unparseable fingerprint/u);
    expect(runners.claims).toEqual([]);
  });

  it("retries a transient ECONNRESET during host-key discovery, then succeeds", async () => {
    // Part A (apex-v35): a momentary `read ECONNRESET` while the runner is briefly
    // unavailable mid-handshake is TRANSIENT — it must NOT fail the allocate. The first
    // attempt errors with ECONNRESET; the retry succeeds and the fingerprint is captured.
    const runners = new FakeRunnerStore();
    let attempt = 0;
    const factory = () => {
      attempt += 1;
      // First attempt: emit a transient socket reset (no fingerprint captured).
      // Subsequent attempts: a normal successful discovery.
      const fp = attempt === 1 ? undefined : "c".repeat(64);
      const errored = attempt === 1;
      return fakeClientFactory({
        fingerprint: fp,
        emitError: true,
        ...(errored && { transientReset: true }),
      })();
    };
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: factory,
      // A no-wait sleep keeps the test fast.
      retrySleep: async () => {},
    });

    const allocation = await allocator.allocate({
      runId: "run_retry",
      projectId: "p",
      runnerImage: "img",
      identitySecretRef: "runner/dev/identity",
    });

    // The first ECONNRESET was retried, the second attempt succeeded.
    expect(attempt).toBe(2);
    const expected = "SHA256:" + Buffer.from("c".repeat(64), "hex").toString("base64").replace(/=+$/u, "");
    expect(allocation.target.hostKeyFingerprint).toBe(expected);
    expect(runners.claims).toHaveLength(1);
  });

  it("fails loud after the bounded retries when EVERY attempt is a transient ECONNRESET", async () => {
    // A persistent transient (the runner stays down): retry the bounded number of times,
    // then surface LOUD with the real cause — never a silent fallback, never an infinite loop.
    const runners = new FakeRunnerStore();
    let attempt = 0;
    const factory = () => {
      attempt += 1;
      return fakeClientFactory({ fingerprint: undefined, emitError: true, transientReset: true })();
    };
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: factory,
      discoverTransientAttempts: 3,
      retrySleep: async () => {},
    });

    await expect(
      allocator.allocate({
        runId: "run_persist",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/ECONNRESET/u);
    // All bounded attempts were exhausted before failing loud.
    expect(attempt).toBe(3);
    expect(runners.claims).toEqual([]);
  });

  it("does NOT retry a non-transient (auth/host-key) discovery failure — fails immediately", async () => {
    // A genuine non-transient failure (host key verification / auth) is NOT a blip — it
    // must fail on the FIRST attempt, never be retried as if it were a transient.
    const runners = new FakeRunnerStore();
    let attempt = 0;
    const factory = () => {
      attempt += 1;
      return fakeClientFactory({ fingerprint: undefined, emitError: true })();
    };
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: factory,
      discoverTransientAttempts: 4,
      retrySleep: async () => {},
    });

    await expect(
      allocator.allocate({
        runId: "run_auth",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity",
      }),
    ).rejects.toThrow(/host key discovery failed/u);
    // A non-transient error is NOT retried — it fails on the first attempt.
    expect(attempt).toBe(1);
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
