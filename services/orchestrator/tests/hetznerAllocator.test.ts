import { describe, expect, it } from "vitest";
import {
  fetchHetznerClient,
  HetznerAllocator,
  type HetznerClient,
  type HetznerCreateServerInput,
  type HetznerServer,
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
  constructor(private readonly opts: { neverRuns?: boolean; noIp?: boolean; emptyIp?: boolean } = {}) {}

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
      publicIpv4: this.opts.noIp ? undefined : this.opts.emptyIp ? "" : "203.0.113.10",
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
  sleep: async () => {},
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_h",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
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
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become running/u);
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
    expect(() => new HetznerAllocator({ ...baseOpts(new FakeHetznerClient(), runners), apiToken: "" })).toThrow(
      /non-empty apiToken/u,
    );
    expect(
      () =>
        new HetznerAllocator({
          ...baseOpts(new FakeHetznerClient(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/u);
  });

  it("sanitizes the run id into a lowercase, hyphen-only server name", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator(baseOpts(client, runners));
    await allocator.allocate(req("Run_ABC/123"));
    // tanren- prefix, lowercased, every non [a-z0-9-] char replaced with "-".
    expect(client.created[0]?.name).toBe("tanren-run-abc-123");
  });

  it("destroys the server and rejects when it becomes running without an IP", async () => {
    const client = new FakeHetznerClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    // status reaches "running" but publicIpv4 stays undefined: the ready
    // condition requires BOTH, so it never returns and the deadline trips.
    await expect(allocator.allocate(req("run_no_ip"))).rejects.toThrow(/did not become running/u);
    expect(client.deleted).toEqual([42]);
    expect(runners.claims).toEqual([]);
  });

  // waitForRunning requires the server to be "running" AND hold a non-empty
  // IPv4. An empty-string IPv4 must NOT satisfy the ready condition, so the
  // wait keeps polling until the deadline and the server is destroyed.
  it("treats an empty-string IPv4 as not-yet-ready and destroys on timeout", async () => {
    const client = new FakeHetznerClient({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new HetznerAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_empty"))).rejects.toThrow(/did not become running/u);
    expect(client.deleted).toEqual([42]);
    expect(runners.claims).toEqual([]);
  });

  // The create body carries the Hetzner server spec plus the always-on
  // start_after_create flag and the snake_cased field names. Pin the POSTed
  // body so the JSON.stringify field mapping is behavior-asserted.
  it("fetchHetznerClient POSTs the server spec with start_after_create and snake_case fields", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ server: { id: 7, status: "initializing", public_net: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    await client.createServer({
      name: "tanren-run-1",
      serverType: "cx32",
      image: "docker-ce",
      location: "fsn1",
    });
    expect(body.name).toBe("tanren-run-1");
    expect(body.server_type).toBe("cx32");
    expect(body.image).toBe("docker-ce");
    expect(body.location).toBe("fsn1");
    expect(body.start_after_create).toBe(true);
  });

  // toServer maps a present ipv4.ip into publicIpv4 (not just null -> undefined).
  it("fetchHetznerClient maps a present public_net ipv4 into publicIpv4", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ server: { id: 9, status: "running", public_net: { ipv4: { ip: "203.0.113.99" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    const server = await client.getServer(9);
    expect(server).toEqual({ id: 9, status: "running", publicIpv4: "203.0.113.99" });
  });

  it("fetchHetznerClient GETs the server and DELETEs it (404 delete is idempotent)", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
      if (init?.method === "DELETE") {
        return new Response("gone", { status: 404 });
      }
      return new Response(JSON.stringify({ server: { id: 3, status: "running", public_net: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    await client.getServer(3);
    await expect(client.deleteServer(3)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0]?.url).toMatch(/\/servers\/3$/u);
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]?.url).toMatch(/\/servers\/3$/u);
  });

  it("toServer treats a null public_net as no IP (via fetchHetznerClient)", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ server: { id: 9, status: "initializing", public_net: null } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    const server = await client.createServer({ name: "n", serverType: "cx22", image: "docker-ce" });
    expect(server.publicIpv4).toBeUndefined();
  });

  it("fetchHetznerClient maps the API response and sends the bearer token", async () => {
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
          server: { id: 7, status: "running", public_net: { ipv4: { ip: "198.51.100.5" } } },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = fetchHetznerClient("secret-token", fetchImpl);
    const server = await client.createServer({ name: "n", serverType: "cx22", image: "docker-ce" });
    expect(captured.url).toMatch(/\/servers$/u);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(server).toEqual({ id: 7, status: "running", publicIpv4: "198.51.100.5" });
  });
});
