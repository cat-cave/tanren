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

function fakeClientFactory(opts: FakeClientOptions) {
  return () => {
    const emitter = new EventEmitter();
    return {
      once: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.once(event, handler);
        return emitter;
      },
      connect: (config: { hostVerifier?: (fingerprint: string) => boolean }) => {
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
      destroy: () => undefined,
      end: () => undefined
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
      runners
    });

    const allocation = await allocator.allocate({
      runId: "run_abc",
      projectId: "proj_abc",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/dev/identity"
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
        fingerprint: "a".repeat(64)
      })
    });

    const allocation = await allocator.allocate({
      runId: "run_tofu",
      projectId: "proj_tofu",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/dev/identity"
    });

    expect(allocation.target.hostKeyFingerprint).toMatch(/^SHA256:/);
    expect(runners.claims).toHaveLength(1);
  });

  it("rejects when the SSH handshake errors before a fingerprint is captured", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      runners,
      clientFactory: fakeClientFactory({ fingerprint: undefined, emitError: true })
    });

    await expect(
      allocator.allocate({
        runId: "run_err",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "runner/dev/identity"
      })
    ).rejects.toThrow(/host key discovery failed/);
  });

  it("releases by clearing the orchestrator mirror row only", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new StaticRunnerAllocator({
      host: "runner",
      port: 22,
      hostKeyFingerprint: "SHA256:test",
      runners
    });

    await allocator.release("runner_run_xyz", "completed");
    expect(runners.releases).toEqual(["runner_run_xyz"]);
  });
});
