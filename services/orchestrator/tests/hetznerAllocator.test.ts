import { describe, expect, it } from "vitest";
import {
  fetchHetznerClient,
  HetznerAllocator,
  type HetznerClient,
  type HetznerCreateServerInput,
  type HetznerCreateSshKeyInput,
  type HetznerServer,
  type HetznerSshKey,
} from "../src/engine/allocators/hetznerAllocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  generateEd25519KeyPair,
  hostKeyFingerprintFromPublicKey,
  type EphemeralKeyPair,
} from "../src/engine/ssh/keygen.js";

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
 * Mocked Hetzner API: created server is "initializing" then "running". Records
 * the ssh-key + server creates/deletes so the ephemeral-key + teardown
 * lifecycle is behavior-asserted.
 */
class FakeHetznerClient implements HetznerClient {
  readonly createdKeys: HetznerCreateSshKeyInput[] = [];
  readonly deletedKeys: number[] = [];
  readonly created: HetznerCreateServerInput[] = [];
  readonly deleted: number[] = [];
  private getCalls = 0;
  private nextKeyId = 555;
  constructor(
    private readonly opts: { neverRuns?: boolean; noIp?: boolean; emptyIp?: boolean; failCreateServer?: boolean } = {},
  ) {}

  async createSshKey(input: HetznerCreateSshKeyInput): Promise<HetznerSshKey> {
    this.createdKeys.push(input);
    return { id: this.nextKeyId++ };
  }
  async deleteSshKey(sshKeyId: number): Promise<void> {
    this.deletedKeys.push(sshKeyId);
  }
  async createServer(input: HetznerCreateServerInput): Promise<HetznerServer> {
    if (this.opts.failCreateServer) {
      throw new Error("hetzner createServer boom");
    }
    this.created.push(input);
    return { id: 42, status: "initializing", publicIpv4: undefined };
  }
  async getServer(serverId: number): Promise<HetznerServer> {
    this.getCalls += 1;
    if (this.opts.neverRuns) {
      return { id: serverId, status: "initializing" };
    }
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

// A fixed fake CLIENT key (so the stored private key is pinnable) followed by a
// real generated HOST key (so its fingerprint is computable + verifiable).
const CLIENT_KEY: EphemeralKeyPair = {
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nCLIENT-FAKE\n-----END OPENSSH PRIVATE KEY-----",
  publicKey: "ssh-ed25519 AAAAClientKeyMaterial tanren-client",
};

/**
 * Deterministic keygen: yields the fixed client key first, then a freshly
 * generated real host key. Returns the pinned host fingerprint alongside.
 */
function keyGenSequence(): { gen: () => EphemeralKeyPair; hostFingerprint: string } {
  const hostKey = generateEd25519KeyPair();
  const seq = [CLIENT_KEY, hostKey];
  let i = 0;
  return {
    gen: (): EphemeralKeyPair => seq[i++ % seq.length] as EphemeralKeyPair,
    hostFingerprint: hostKeyFingerprintFromPublicKey(hostKey.publicKey),
  };
}

function baseOpts(client: HetznerClient, runners: RunnerStore, secrets: InMemorySecretStore) {
  return {
    apiToken: "tok",
    serverType: "cx22",
    image: "docker-ce",
    location: "nbg1",
    runners,
    secrets,
    client,
    generateKeyPair: keyGenSequence().gen,
    sleep: async (): Promise<void> => undefined,
  };
}

/** A Hetzner allocator with a fresh deterministic keygen for the happy path. */
function allocator(client: HetznerClient, runners: RunnerStore, secrets: InMemorySecretStore): HetznerAllocator {
  return new HetznerAllocator(baseOpts(client, runners, secrets));
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_h",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

describe("HetznerAllocator", () => {
  it("uploads an ephemeral key, stores the private key, references the key id, and pins a computed host fingerprint", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const { gen, hostFingerprint } = keyGenSequence();
    const alloc = new HetznerAllocator({ ...baseOpts(client, runners, secrets), generateKeyPair: gen });

    const allocation = await alloc.allocate(req("run_1"));

    // Ephemeral public key uploaded to Hetzner.
    expect(client.createdKeys).toHaveLength(1);
    expect(client.createdKeys[0]?.publicKey).toBe(CLIENT_KEY.publicKey);
    // Server references the uploaded key id (not a manual key name).
    expect(client.created[0]?.sshKeys).toEqual([555]);
    // Private key stored under the per-run ref the target points at; never inlined.
    expect(allocation.target.identitySecretRef).toBe("hetzner/runner_run_1/identity");
    const stored = await secrets.get(allocation.target.identitySecretRef);
    expect(stored?.value).toBe(CLIENT_KEY.privateKey);
    // Host key injected via cloud-init + the matching fingerprint pinned (computed,
    // no manual fingerprint input).
    expect(allocation.target.hostKeyFingerprint).toBe(hostFingerprint);
    expect(client.created[0]?.userData).toContain("/etc/ssh/ssh_host_ed25519_key");
    expect(allocation.target.host).toBe("203.0.113.10");
    expect(allocation.target.username).toBe("root");
    expect(runners.claims[0]?.hostKeyFingerprint).toBe(hostFingerprint);
    expect(runners.claims[0]?.containerId).toBe("42");
  });

  it("never logs or returns the private key or host private key in the create body / target / claim", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const allocation = await allocator(client, runners, secrets).allocate(req("run_secret"));

    // The CLIENT private key lives ONLY in the secret store, not the create body,
    // the target, or the runners-claim mirror row.
    const serialized = JSON.stringify({ created: client.created, allocation, claims: runners.claims });
    expect(serialized).not.toContain("CLIENT-FAKE");
    // The HOST private key is only inside user_data (sensitive cloud-init), never
    // in the returned target.
    expect(JSON.stringify(allocation)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("on release destroys the server, deletes the Hetzner ssh_key, and wipes the stored private key", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const alloc = allocator(client, runners, secrets);
    const allocation = await alloc.allocate(req("run_2"));
    expect(await secrets.get(allocation.target.identitySecretRef)).toBeDefined();

    await alloc.release(allocation.runnerId, "completed");
    expect(client.deleted).toEqual([42]);
    expect(client.deletedKeys).toEqual([555]);
    expect(await secrets.get(allocation.target.identitySecretRef)).toBeUndefined();
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("cleans up the ssh_key + stored private key when server-create fails", async () => {
    const client = new FakeHetznerClient({ failCreateServer: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    await expect(allocator(client, runners, secrets).allocate(req("run_fail_create"))).rejects.toThrow(/boom/u);
    // The uploaded key is deleted and the stored private key wiped — no leak.
    expect(client.deletedKeys).toEqual([555]);
    expect(await secrets.list("hetzner/")).toEqual([]);
  });

  it("destroys the server + key and wipes the secret if it never becomes running", async () => {
    const client = new FakeHetznerClient({ neverRuns: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const alloc = new HetznerAllocator({
      ...baseOpts(client, runners, secrets),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(alloc.allocate(req("run_3"))).rejects.toThrow(/did not become running/u);
    expect(client.deleted).toEqual([42]);
    expect(client.deletedKeys).toEqual([555]);
    expect(await secrets.list("hetzner/")).toEqual([]);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    await allocator(client, runners, secrets).release("runner_unknown");
    expect(client.deleted).toEqual([]);
    expect(client.deletedKeys).toEqual([]);
  });

  // Regression for the ssh2@1.17.0 malformed-public-key bug: an UNPARSEABLE
  // public key escaping the generator must NOT cause a teardown leak. Because
  // all keypair generation + the host-key fingerprint are computed in Phase 1
  // (before any external side effect), a bad key fails BEFORE secrets.put /
  // createSshKey / createServer — so nothing is stored or provisioned to leak.
  it("rejects with NO external side effect when a malformed public key reaches the fingerprint step", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    // First call (client key) is fine; the host key is malformed -> the Phase-1
    // host-key fingerprint computation throws before anything external runs.
    const hostKey: EphemeralKeyPair = { privateKey: "p", publicKey: "not-a-valid-ssh-public-key" };
    let i = 0;
    const seq = [CLIENT_KEY, hostKey];
    const alloc = new HetznerAllocator({
      ...baseOpts(client, runners, secrets),
      generateKeyPair: (): EphemeralKeyPair => seq[i++] as EphemeralKeyPair,
    });

    await expect(alloc.allocate(req("run_bad_key"))).rejects.toThrow(/could not parse host public key/u);
    // Nothing was uploaded, created, or stored — no dangling resources.
    expect(client.createdKeys).toEqual([]);
    expect(client.created).toEqual([]);
    expect(client.deletedKeys).toEqual([]);
    expect(client.deleted).toEqual([]);
    expect(await secrets.list("hetzner/")).toEqual([]);
  });

  // If a throw DOES happen after an external step (e.g. the server-create
  // rejects right after the ssh_key was uploaded + the private key stored), the
  // extended cleanup guard must still funnel through cleanup(): delete the
  // ssh_key AND wipe the secret. (Pinned via the existing failCreateServer path,
  // re-asserted here for the no-leak invariant.)
  it("funnels any post-upload throw through cleanup so the ssh_key + secret never dangle", async () => {
    const client = new FakeHetznerClient({ failCreateServer: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    await expect(allocator(client, runners, secrets).allocate(req("run_post_upload"))).rejects.toThrow(/boom/u);
    expect(client.createdKeys).toHaveLength(1);
    expect(client.deletedKeys).toEqual([555]);
    // server-create never returned a server, so there is nothing to delete.
    expect(client.deleted).toEqual([]);
    expect(await secrets.list("hetzner/")).toEqual([]);
  });

  it("requires a non-empty token", () => {
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    expect(
      () => new HetznerAllocator({ ...baseOpts(new FakeHetznerClient(), runners, secrets), apiToken: "" }),
    ).toThrow(/non-empty apiToken/u);
  });

  it("sanitizes the run id into a lowercase, hyphen-only server + key name", async () => {
    const client = new FakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    await allocator(client, runners, secrets).allocate(req("Run_ABC/123"));
    expect(client.created[0]?.name).toBe("tanren-run-abc-123");
    expect(client.createdKeys[0]?.name).toBe("tanren-run-abc-123");
  });

  it("destroys everything and rejects when it becomes running without an IP", async () => {
    const client = new FakeHetznerClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const alloc = new HetznerAllocator({
      ...baseOpts(client, runners, secrets),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(alloc.allocate(req("run_no_ip"))).rejects.toThrow(/did not become running/u);
    expect(client.deleted).toEqual([42]);
    expect(client.deletedKeys).toEqual([555]);
    expect(runners.claims).toEqual([]);
  });

  it("treats an empty-string IPv4 as not-yet-ready and destroys on timeout", async () => {
    const client = new FakeHetznerClient({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    const alloc = new HetznerAllocator({
      ...baseOpts(client, runners, secrets),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(alloc.allocate(req("run_empty"))).rejects.toThrow(/did not become running/u);
    expect(client.deleted).toEqual([42]);
    expect(runners.claims).toEqual([]);
  });

  // --- fetchHetznerClient HTTP mapping ---------------------------------------
  it("fetchHetznerClient POSTs the ssh_key with a snake_case public_key", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ssh_key: { id: 99 } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    const key = await client.createSshKey({ name: "tanren-run-1", publicKey: "ssh-ed25519 AAAA" });
    expect(body.name).toBe("tanren-run-1");
    expect(body.public_key).toBe("ssh-ed25519 AAAA");
    expect(key).toEqual({ id: 99 });
  });

  it("fetchHetznerClient DELETEs the ssh_key (404 is idempotent)", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: typeof input === "string" ? input : input.toString(), method: init?.method });
      return new Response("gone", { status: 404 });
    }) as typeof fetch;
    const client = fetchHetznerClient("tok", fetchImpl);
    await expect(client.deleteSshKey(99)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE" });
    expect(calls[0]?.url).toMatch(/\/ssh_keys\/99$/u);
  });

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
      sshKeys: [99],
    });
    expect(body.name).toBe("tanren-run-1");
    expect(body.server_type).toBe("cx32");
    expect(body.ssh_keys).toEqual([99]);
    expect(body.start_after_create).toBe(true);
  });

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
    expect(calls[1]).toMatchObject({ method: "DELETE" });
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

  it("fetchHetznerClient sends the bearer token", async () => {
    let auth: string | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return new Response(
        JSON.stringify({ server: { id: 7, status: "running", public_net: { ipv4: { ip: "198.51.100.5" } } } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = fetchHetznerClient("secret-token", fetchImpl);
    await client.createServer({ name: "n", serverType: "cx22", image: "docker-ce" });
    expect(auth).toBe("Bearer secret-token");
  });
});
