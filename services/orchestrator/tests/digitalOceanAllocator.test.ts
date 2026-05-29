import { describe, expect, it } from "vitest";
import {
  DigitalOceanAllocator,
  DigitalOceanAllocatorError,
  fetchDigitalOceanClient,
  type DigitalOceanClient,
  type DigitalOceanCreateDropletInput,
  type DigitalOceanDroplet,
} from "../src/engine/allocators/digitalOceanAllocator.js";
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

/** Mocked DO API: created droplet is "new" then "active" with a public IP. */
class FakeDigitalOceanClient implements DigitalOceanClient {
  readonly created: DigitalOceanCreateDropletInput[] = [];
  readonly deleted: number[] = [];
  private getCalls = 0;
  constructor(private readonly opts: { neverActive?: boolean; noIp?: boolean } = {}) {}

  async createDroplet(input: DigitalOceanCreateDropletInput): Promise<DigitalOceanDroplet> {
    this.created.push(input);
    return { id: 99, status: "new", publicIpv4: undefined };
  }
  async getDroplet(dropletId: number): Promise<DigitalOceanDroplet> {
    this.getCalls += 1;
    if (this.opts.neverActive) {
      return { id: dropletId, status: "new" };
    }
    if (this.getCalls < 2) {
      return { id: dropletId, status: "new" };
    }
    return {
      id: dropletId,
      status: "active",
      publicIpv4: this.opts.noIp ? undefined : "203.0.113.20",
    };
  }
  async deleteDroplet(dropletId: number): Promise<void> {
    this.deleted.push(dropletId);
  }
}

const baseOpts = (client: DigitalOceanClient, runners: RunnerStore) => ({
  apiToken: "tok",
  hostKeyFingerprint: "SHA256:digitalocean",
  region: "nyc3",
  size: "s-1vcpu-1gb",
  image: "docker-20-04",
  runners,
  client,
  sleep: async () => undefined,
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_do",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

describe("DigitalOceanAllocator", () => {
  it("creates a droplet, waits for active+IP, and returns the SSH target", async () => {
    const client = new FakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator(baseOpts(client, runners));

    const allocation = await allocator.allocate(req("run_1"));
    expect(client.created).toHaveLength(1);
    expect(client.created[0]?.size).toBe("s-1vcpu-1gb");
    expect(client.created[0]?.region).toBe("nyc3");
    expect(client.created[0]?.tags).toContain("tanren-run-run_1");
    expect(allocation.target.host).toBe("203.0.113.20");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("root");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:digitalocean");
    expect(runners.claims[0]?.allocator).toBe("digitalocean");
    expect(runners.claims[0]?.containerId).toBe("99");
  });

  it("destroys the droplet and clears the mirror row on release", async () => {
    const client = new FakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2"));
    await allocator.release(allocation.runnerId, "completed");
    expect(client.deleted).toEqual([99]);
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("release is idempotent: releasing twice destroys only once", async () => {
    const client = new FakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2b"));
    await allocator.release(allocation.runnerId);
    await allocator.release(allocation.runnerId);
    expect(client.deleted).toEqual([99]);
  });

  it("surfaces a typed error and destroys the droplet if it never becomes active", async () => {
    const client = new FakeDigitalOceanClient({ neverActive: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_3"))).rejects.toBeInstanceOf(DigitalOceanAllocatorError);
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become active/);
    expect(client.deleted).toContain(99);
  });

  it("surfaces a typed error and destroys the droplet if it has no public IP", async () => {
    const client = new FakeDigitalOceanClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_4"))).rejects.toBeInstanceOf(DigitalOceanAllocatorError);
    expect(client.deleted).toContain(99);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator(baseOpts(client, runners));
    await allocator.release("runner_unknown");
    expect(client.deleted).toEqual([]);
  });

  it("requires a token and pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(
      () =>
        new DigitalOceanAllocator({
          ...baseOpts(new FakeDigitalOceanClient(), runners),
          apiToken: "",
        }),
    ).toThrow(/non-empty apiToken/);
    expect(
      () =>
        new DigitalOceanAllocator({
          ...baseOpts(new FakeDigitalOceanClient(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/);
  });

  it("fetchDigitalOceanClient maps the API response and sends the bearer token", async () => {
    let captured: { url: string; method?: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      };
      return new Response(
        JSON.stringify({
          droplet: {
            id: 7,
            status: "active",
            networks: {
              v4: [
                { ip_address: "10.0.0.1", type: "private" },
                { ip_address: "198.51.100.9", type: "public" },
              ],
            },
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = fetchDigitalOceanClient("secret-token", fetchImpl);
    const droplet = await client.createDroplet({
      name: "n",
      region: "nyc3",
      size: "s-1vcpu-1gb",
      image: "docker-20-04",
    });
    expect(captured.url).toMatch(/\/droplets$/);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(droplet).toEqual({ id: 7, status: "active", publicIpv4: "198.51.100.9" });
  });

  it("fetchDigitalOceanClient treats a 404 delete as success (idempotent)", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("not found", { status: 404 })) as typeof fetch;
    const client = fetchDigitalOceanClient("secret-token", fetchImpl);
    await expect(client.deleteDroplet(123)).resolves.toBeUndefined();
  });
});
