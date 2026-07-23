import { describe, expect, it } from "vitest";
import { ManualSshAllocator } from "../src/engine/allocators/manualSshAllocator.js";
import {
  PoolLeaseCapacityError,
  PoolLeaseExhaustedError,
  StaleLeaseReleaseError,
  type PoolLeaseReleaseOutcome,
  type PoolLeaseReservation,
  type ReleasePoolLeaseInput,
  type ReservePoolLeaseInput,
  type RunnerPoolLeaseStore,
} from "../src/engine/allocators/runnerStore.js";

// #1254: the allocator no longer tracks busy hosts / the cap in memory — it
// delegates to the shared-store lease seam. This fake models that seam's ATOMIC
// contract (single-threaded JS, so the "atomicity" is trivially exact here): one
// live lease per (poolKey, leaseKey), the `maxConcurrent` cap, fenced release. The
// real cross-process proof (two contending reservers) lives in the RLS integration
// test against Postgres.
class FakeLeaseStore implements RunnerPoolLeaseStore {
  /** poolKey -> leaseKey -> the live lease record. */
  private readonly live = new Map<string, Map<string, { runnerId: string; owner: string; token: string }>>();
  /** runnerId -> its live (poolKey, leaseKey), for release lookup. */
  private readonly byRunner = new Map<string, { poolKey: string; leaseKey: string }>();
  private nextToken = 1;
  readonly releaseCalls: ReleasePoolLeaseInput[] = [];

  private poolMap(poolKey: string): Map<string, { runnerId: string; owner: string; token: string }> {
    let map = this.live.get(poolKey);
    if (map === undefined) {
      map = new Map();
      this.live.set(poolKey, map);
    }
    return map;
  }

  async reservePoolLease(input: ReservePoolLeaseInput): Promise<PoolLeaseReservation> {
    const pool = this.poolMap(input.poolKey);
    if (input.maxConcurrent !== undefined && pool.size >= input.maxConcurrent) {
      throw new PoolLeaseCapacityError(input.poolKey, input.maxConcurrent);
    }
    const chosen = input.candidates.find((candidate) => !pool.has(candidate.leaseKey));
    if (chosen === undefined) {
      throw new PoolLeaseExhaustedError(input.poolKey, input.candidates.length);
    }
    const token = String(this.nextToken++);
    pool.set(chosen.leaseKey, { runnerId: input.runnerId, owner: input.owner, token });
    this.byRunner.set(input.runnerId, { poolKey: input.poolKey, leaseKey: chosen.leaseKey });
    return {
      leaseKey: chosen.leaseKey,
      sshHost: chosen.sshHost,
      sshPort: chosen.sshPort,
      hostKeyFingerprint: chosen.hostKeyFingerprint,
      containerId: chosen.containerId,
      owner: input.owner,
      fencingToken: token,
    };
  }

  async releasePoolLease(input: ReleasePoolLeaseInput): Promise<PoolLeaseReleaseOutcome> {
    this.releaseCalls.push(input);
    const where = this.byRunner.get(input.runnerId);
    if (where === undefined) return { released: false };
    const record = this.poolMap(where.poolKey).get(where.leaseKey);
    if (record === undefined || record.runnerId !== input.runnerId) return { released: false };
    if (record.owner !== input.owner || record.token !== input.fencingToken) {
      throw new StaleLeaseReleaseError(input.runnerId);
    }
    this.poolMap(where.poolKey).delete(where.leaseKey);
    this.byRunner.delete(input.runnerId);
    return { released: true };
  }

  /** Test helper: the leaseKey currently held for a poolKey, if any. */
  heldKeys(poolKey = "manual_ssh"): string[] {
    return [...this.poolMap(poolKey).keys()];
  }
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_a",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

describe("ManualSshAllocator", () => {
  it("leases a configured host through the shared store and returns its target", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [
        {
          id: "host-1",
          host: "10.0.0.1",
          port: 2200,
          username: "tanren",
          hostKeyFingerprint: "SHA256:abc",
          identitySecretRef: "runner/host-1/key",
        },
      ],
      leases,
    });

    const allocation = await allocator.allocate(req("run_1"));
    expect(allocation.runnerId).toBe("runner_run_1");
    expect(allocation.target.host).toBe("10.0.0.1");
    expect(allocation.target.port).toBe(2200);
    expect(allocation.target.identitySecretRef).toBe("runner/host-1/key");
    // The lease is recorded in the SHARED store, keyed by the host id — not an
    // in-memory set on the allocator.
    expect(leases.heldKeys()).toEqual(["host-1"]);
  });

  it("falls back to the request identity ref and default username/port", async () => {
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "h", host: "h.example", hostKeyFingerprint: "SHA256:x" }],
      leases: new FakeLeaseStore(),
    });
    const allocation = await allocator.allocate(req("run_2"));
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.identitySecretRef).toBe("runner/identity");
  });

  it("uses the host username over the configured default", async () => {
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "h", host: "h.example", username: "host-user", hostKeyFingerprint: "SHA256:x" }],
      defaultUsername: "poolDefault",
      leases: new FakeLeaseStore(),
    });
    const allocation = await allocator.allocate(req("run_hu"));
    expect(allocation.target.username).toBe("host-user");
  });

  it("falls back to the configured default username when the host omits one", async () => {
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "h", host: "h.example", hostKeyFingerprint: "SHA256:x" }],
      defaultUsername: "poolDefault",
      leases: new FakeLeaseStore(),
    });
    const allocation = await allocator.allocate(req("run_du"));
    expect(allocation.target.username).toBe("poolDefault");
  });

  it("leases distinct hosts and fails when the pool is exhausted", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [
        { id: "a", host: "a", hostKeyFingerprint: "SHA256:a" },
        { id: "b", host: "b", hostKeyFingerprint: "SHA256:b" },
      ],
      leases,
    });
    const first = await allocator.allocate(req("run_a"));
    const second = await allocator.allocate(req("run_b"));
    expect(first.target.host).toBe("a");
    expect(second.target.host).toBe("b");
    await expect(allocator.allocate(req("run_c"))).rejects.toBeInstanceOf(PoolLeaseExhaustedError);
  });

  it("refuses a lease that would exceed the shared maxConcurrent cap", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [
        { id: "a", host: "a", hostKeyFingerprint: "SHA256:a" },
        { id: "b", host: "b", hostKeyFingerprint: "SHA256:b" },
      ],
      leases,
      maxConcurrent: 1,
    });
    await allocator.allocate(req("run_a"));
    // A free host exists (b), but the cap is 1 — the reservation is refused.
    await expect(allocator.allocate(req("run_b"))).rejects.toBeInstanceOf(PoolLeaseCapacityError);
  });

  it("advertises that it enforces its own pool cap (router delegates)", () => {
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "h", host: "h", hostKeyFingerprint: "SHA256:x" }],
      leases: new FakeLeaseStore(),
    });
    expect(allocator.enforcesOwnPoolCap).toBe(true);
  });

  it("frees the host on release so it can be reused", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "only", host: "only", hostKeyFingerprint: "SHA256:o" }],
      leases,
    });
    const a = await allocator.allocate(req("run_x"));
    await allocator.release(a.runnerId, "completed");
    expect(leases.releaseCalls.map((c) => c.runnerId)).toEqual(["runner_run_x"]);
    expect(leases.heldKeys()).toEqual([]);
    // Host is free again.
    const b = await allocator.allocate(req("run_y"));
    expect(b.target.host).toBe("only");
  });

  it("passes the fencing owner + token it holds when releasing its own lease", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "only", host: "only", hostKeyFingerprint: "SHA256:o" }],
      leases,
    });
    const a = await allocator.allocate(req("run_z"));
    await allocator.release(a.runnerId);
    const call = leases.releaseCalls[0]!;
    expect(call.owner).toMatch(/^manual_ssh:/u);
    expect(call.fencingToken).toBe("1");
  });

  it("release of an unknown runner is a no-op (never guesses another owner's token)", async () => {
    const leases = new FakeLeaseStore();
    const allocator = new ManualSshAllocator({
      hosts: [{ id: "only", host: "only", hostKeyFingerprint: "SHA256:o" }],
      leases,
    });
    await allocator.release("runner_never_allocated");
    expect(leases.releaseCalls).toEqual([]);
  });

  it("throws when constructed with an empty host pool", () => {
    expect(() => new ManualSshAllocator({ hosts: [], leases: new FakeLeaseStore() })).toThrow(
      /at least one configured host/u,
    );
  });
});
