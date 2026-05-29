import { describe, expect, it } from "vitest";
import {
  fetchGcpComputeClient,
  GcpAllocator,
  GcpAllocatorError,
  type GcpComputeClient,
  type GcpInsertInstanceInput,
  type GcpInstance,
  type GcpOperation
} from "../src/engine/allocators/gcpAllocator.js";
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

/**
 * Mocked GCP API: insert returns a RUNNING op that goes DONE on the next poll;
 * the instance is PROVISIONING then RUNNING with an external IP.
 */
class FakeGcpComputeClient implements GcpComputeClient {
  readonly inserted: GcpInsertInstanceInput[] = [];
  readonly deleted: string[] = [];
  private getCalls = 0;
  constructor(
    private readonly opts: { opError?: string; neverRunning?: boolean; noIp?: boolean } = {}
  ) {}

  async insertInstance(input: GcpInsertInstanceInput): Promise<GcpOperation> {
    this.inserted.push(input);
    if (this.opts.opError !== undefined) {
      return { name: "op-1", status: "RUNNING", error: this.opts.opError };
    }
    return { name: "op-1", status: "RUNNING" };
  }
  async getZoneOperation(operationName: string): Promise<GcpOperation> {
    return { name: operationName, status: "DONE" };
  }
  async getInstance(instanceName: string): Promise<GcpInstance> {
    this.getCalls += 1;
    if (this.opts.neverRunning) {
      return { name: instanceName, status: "PROVISIONING" };
    }
    if (this.getCalls < 2) {
      return { name: instanceName, status: "PROVISIONING" };
    }
    return {
      name: instanceName,
      status: "RUNNING",
      externalIp: this.opts.noIp ? undefined : "203.0.113.50"
    };
  }
  async deleteInstance(instanceName: string): Promise<void> {
    this.deleted.push(instanceName);
  }
}

const baseOpts = (client: GcpComputeClient, runners: RunnerStore) => ({
  accessToken: "tok",
  project: "proj-gcp",
  zone: "us-central1-a",
  machineType: "e2-small",
  sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
  sshUsername: "tanren",
  sshPublicKey: "ssh-ed25519 AAAA runner@tanren",
  hostKeyFingerprint: "SHA256:gcp",
  runners,
  client,
  sleep: async () => undefined
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_gcp",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity"
  };
}

describe("GcpAllocator", () => {
  it("inserts an instance, waits for op DONE + RUNNING + IP, and returns the SSH target", async () => {
    const client = new FakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator(baseOpts(client, runners));

    const allocation = await allocator.allocate(req("run_1"));
    expect(client.inserted).toHaveLength(1);
    expect(client.inserted[0]?.machineType).toBe("e2-small");
    expect(client.inserted[0]?.sshPublicKey).toBe("ssh-ed25519 AAAA runner@tanren");
    expect(client.inserted[0]?.labels?.["tanren-run"]).toBe("run_1");
    expect(allocation.target.host).toBe("203.0.113.50");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:gcp");
    expect(runners.claims[0]?.allocator).toBe("gcp");
    expect(runners.claims[0]?.containerId).toBe("tanren-run-1");
  });

  it("deletes the instance and clears the mirror row on release", async () => {
    const client = new FakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2"));
    await allocator.release(allocation.runnerId, "completed");
    expect(client.deleted).toEqual(["tanren-run-2"]);
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("release is idempotent: releasing twice deletes only once", async () => {
    const client = new FakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2b"));
    await allocator.release(allocation.runnerId);
    await allocator.release(allocation.runnerId);
    expect(client.deleted).toEqual(["tanren-run-2b"]);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator(baseOpts(client, runners));
    await allocator.release("runner_unknown");
    expect(client.deleted).toEqual([]);
  });

  it("surfaces a typed error and deletes the instance if the op reports an error", async () => {
    const client = new FakeGcpComputeClient({ opError: "QUOTA_EXCEEDED" });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), readyTimeoutMs: 5, pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_e"))).rejects.toBeInstanceOf(GcpAllocatorError);
    expect(client.deleted).toContain("tanren-run-e");
  });

  it("surfaces a typed error and deletes the instance if it never becomes RUNNING", async () => {
    const client = new FakeGcpComputeClient({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), readyTimeoutMs: 5, pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become RUNNING/);
    expect(client.deleted).toContain("tanren-run-3");
  });

  it("surfaces a typed error and deletes the instance if it has no external IP", async () => {
    const client = new FakeGcpComputeClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), readyTimeoutMs: 5, pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_4"))).rejects.toBeInstanceOf(GcpAllocatorError);
    expect(client.deleted).toContain("tanren-run-4");
  });

  it("requires a token, ssh public key, and pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(() => new GcpAllocator({ ...baseOpts(new FakeGcpComputeClient(), runners), accessToken: "" })).toThrow(
      /non-empty accessToken/
    );
    expect(() => new GcpAllocator({ ...baseOpts(new FakeGcpComputeClient(), runners), sshPublicKey: "" })).toThrow(
      /non-empty sshPublicKey/
    );
    expect(
      () => new GcpAllocator({ ...baseOpts(new FakeGcpComputeClient(), runners), hostKeyFingerprint: "" })
    ).toThrow(/pinned hostKeyFingerprint/);
  });

  it("fetchGcpComputeClient maps the instance response and sends the bearer token", async () => {
    let captured: { url: string; method?: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization
      };
      return new Response(
        JSON.stringify({
          name: "tanren-x",
          status: "RUNNING",
          networkInterfaces: [
            { accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "198.51.100.42" }] }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const client = fetchGcpComputeClient(
      { accessToken: "secret-token", project: "p", zone: "us-central1-a" },
      fetchImpl
    );
    const instance = await client.getInstance("tanren-x");
    expect(captured.url).toMatch(/\/projects\/p\/zones\/us-central1-a\/instances\/tanren-x$/);
    expect(captured.method).toBe("GET");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(instance).toEqual({ name: "tanren-x", status: "RUNNING", externalIp: "198.51.100.42" });
  });

  it("fetchGcpComputeClient surfaces operation errors from the insert response", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          name: "op-9",
          status: "DONE",
          error: { errors: [{ message: "ZONE_RESOURCE_POOL_EXHAUSTED" }] }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const op = await client.insertInstance({
      name: "n",
      machineType: "e2-small",
      sourceImage: "img",
      sshUsername: "tanren",
      sshPublicKey: "ssh-ed25519 AAAA"
    });
    expect(op.error).toBe("ZONE_RESOURCE_POOL_EXHAUSTED");
  });

  it("fetchGcpComputeClient treats a 404 delete as success (idempotent)", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("not found", { status: 404 })) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    await expect(client.deleteInstance("tanren-x")).resolves.toBeUndefined();
  });

  it("fetchGcpComputeClient throws a typed error on non-404 delete failure", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("boom", { status: 500 })) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    await expect(client.deleteInstance("tanren-x")).rejects.toBeInstanceOf(GcpAllocatorError);
  });
});
