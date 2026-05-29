import { describe, expect, it } from "vitest";
import { ManualSshAllocator } from "../src/engine/allocators/manualSshAllocator.js";
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

function req(runId: string) {
  return {
    runId,
    projectId: "proj_a",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity"
  };
}

describe("ManualSshAllocator", () => {
  it("allocates a configured host and mirrors the runner row", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new ManualSshAllocator({
      hosts: [
        {
          id: "host-1",
          host: "10.0.0.1",
          port: 2200,
          username: "tanren",
          hostKeyFingerprint: "SHA256:abc",
          identitySecretRef: "runner/host-1/key"
        }
      ],
      runners
    });

    const allocation = await allocator.allocate(req("run_1"));
    expect(allocation.runnerId).toBe("runner_run_1");
    expect(allocation.target.host).toBe("10.0.0.1");
    expect(allocation.target.port).toBe(2200);
    expect(allocation.target.identitySecretRef).toBe("runner/host-1/key");
    expect(runners.claims).toHaveLength(1);
    expect(runners.claims[0]?.allocator).toBe("manual-ssh");
    expect(runners.claims[0]?.containerId).toBe("host-1");
  });

  it("falls back to the request identity ref and default username/port", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "h", host: "h.example", hostKeyFingerprint: "SHA256:x" }],
      runners
    });
    const allocation = await allocator.allocate(req("run_2"));
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.identitySecretRef).toBe("runner/identity");
  });

  it("leases distinct hosts and fails fast when the pool is exhausted", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new ManualSshAllocator({
      hosts: [
        { id: "a", host: "a", hostKeyFingerprint: "SHA256:a" },
        { id: "b", host: "b", hostKeyFingerprint: "SHA256:b" }
      ],
      runners
    });
    const first = await allocator.allocate(req("run_a"));
    const second = await allocator.allocate(req("run_b"));
    expect(first.target.host).toBe("a");
    expect(second.target.host).toBe("b");
    await expect(allocator.allocate(req("run_c"))).rejects.toThrow(/pool exhausted/);
  });

  it("frees the host on release so it can be reused", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "only", host: "only", hostKeyFingerprint: "SHA256:o" }],
      runners
    });
    const a = await allocator.allocate(req("run_x"));
    await allocator.release(a.runnerId, "completed");
    expect(runners.releases).toEqual(["runner_run_x"]);
    // Host is free again.
    const b = await allocator.allocate(req("run_y"));
    expect(b.target.host).toBe("only");
  });

  it("release of an unknown runner is a no-op", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "only", host: "only", hostKeyFingerprint: "SHA256:o" }],
      runners
    });
    await allocator.release("runner_never_allocated");
    expect(runners.releases).toEqual([]);
  });

  it("throws when constructed with an empty host pool", () => {
    expect(() => new ManualSshAllocator({ hosts: [], runners: new FakeRunnerStore() })).toThrow(
      /at least one configured host/
    );
  });
});
