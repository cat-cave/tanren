import { describe, expect, it } from "vitest";
import {
  fetchHetznerClient,
  HetznerAllocator,
  type HetznerClient,
  type HetznerCreateServerInput,
  type HetznerServer
} from "../src/engine/allocators/hetznerAllocator.js";
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

/** Mocked Hetzner API: created server is "initializing" then "running". */
class FakeHetznerClient implements HetznerClient {
  readonly created: HetznerCreateServerInput[] = [];
  readonly deleted: number[] = [];
  private getCalls = 0;
  constructor(private readonly opts: { neverRuns?: boolean; noIp?: boolean } = {}) {}

  async createServer(input: HetznerCreateServerInput): Promise<HetznerServer> {
    this.created.push(input);
    return { id: 42, status: "initializing", publicIpv4: undefined };
  }
  async getServer(serverId: number): Promise<HetznerServer> {
    this.getCalls += 1;
    if (this.opts.neverRuns) {
      return { id: serverId, status: "initializing" };
    }
    // First poll still initializing, then running.
    if (this.getCalls < 2) {
      return { id: serverId, status: "initializing" };
    }
    return {
      id: serverId,
      status: "running",
      publicIpv4: this.opts.noIp ? undefined : "203.0.113.10"
    };
  }
  async deleteServer(serverId: number): Promise<void> {
    this.deleted.push(serverId);
  }
}

const baseOpts = (client: HetznerClient, runners: RunnerStore) => ({
  apiToken: "tok",
  hostKeyFingerprint: "SHA256:hetzner",
  serverType: "cx22",
  image: "docker-ce",
  location: "nbg1",
  runners,
  client,
  sleep: async () => undefined
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_h",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity"
  };
}

describe("HetznerAllocator", () => {
  it("creates a server, waits for running+IP, and returns the SSH target", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator(baseOpts(client, runners));

    const allocation = await allocator.allocate(req("run_1"));
    expect(client.created).toHaveLength(1);
    expect(client.created[0]?.serverType).toBe("cx22");
    expect(client.created[0]?.labels).toMatchObject({ tanren_run: "run_1" });
    expect(allocation.target.host).toBe("203.0.113.10");
    expect(allocation.target.username).toBe("root");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:hetzner");
    expect(runners.claims[0]?.allocator).toBe("hetzner");
    expect(runners.claims[0]?.containerId).toBe("42");
  });

  it("destroys the server and clears the mirror row on release", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2"));
    await allocator.release(allocation.runnerId, "completed");
    expect(client.deleted).toEqual([42]);
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("destroys the server if it never becomes running", async () => {
    const client = new FakeHetznerClient({ neverRuns: true });
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1
    });
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become running/);
    expect(client.deleted).toEqual([42]);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator(baseOpts(client, runners));
    await allocator.release("runner_unknown");
    expect(client.deleted).toEqual([]);
  });

  it("requires a token and pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(
      () => new HetznerAllocator({ ...baseOpts(new FakeHetznerClient(), runners), apiToken: "" })
    ).toThrow(/non-empty apiToken/);
    expect(
      () =>
        new HetznerAllocator({
          ...baseOpts(new FakeHetznerClient(), runners),
          hostKeyFingerprint: ""
        })
    ).toThrow(/pinned hostKeyFingerprint/);
  });

  it("fetchHetznerClient maps the API response and sends the bearer token", async () => {
    let captured: { url: string; method?: string; auth?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        method: init?.method,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization
      };
      return new Response(
        JSON.stringify({ server: { id: 7, status: "running", public_net: { ipv4: { ip: "198.51.100.5" } } } }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const client = fetchHetznerClient("secret-token", fetchImpl);
    const server = await client.createServer({ name: "n", serverType: "cx22", image: "docker-ce" });
    expect(captured.url).toMatch(/\/servers$/);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(server).toEqual({ id: 7, status: "running", publicIpv4: "198.51.100.5" });
  });
});
