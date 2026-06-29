import { describe, expect, it } from "vitest";
import {
  DigitalOceanAllocator,
  DigitalOceanAllocatorError,
  fetchDigitalOceanClient,
  type DigitalOceanClient,
  type DigitalOceanCreateDropletInput,
  type DigitalOceanDroplet,
} from "../src/engine/allocators/digitalOceanAllocator.js";
import { PersistentProvisioningOutageError } from "../src/engine/allocators/readinessConvergence.js";
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
  constructor(
    private readonly opts: {
      neverActive?: boolean;
      noIp?: boolean;
      emptyIp?: boolean;
      /** Returned on every poll — pins a documented terminal status (off/archive). */
      terminalStatus?: string;
      /** Returned on every poll — pins a brand-new unrecognized status string. */
      unknownStatus?: string;
    } = {},
  ) {}

  async createDroplet(input: DigitalOceanCreateDropletInput): Promise<DigitalOceanDroplet> {
    this.created.push(input);
    return { id: 99, status: "new", publicIpv4: undefined };
  }
  async getDroplet(dropletId: number): Promise<DigitalOceanDroplet> {
    this.getCalls += 1;
    if (this.opts.terminalStatus !== undefined) {
      return { id: dropletId, status: this.opts.terminalStatus };
    }
    if (this.opts.unknownStatus !== undefined) {
      return { id: dropletId, status: this.opts.unknownStatus };
    }
    if (this.opts.neverActive) {
      return { id: dropletId, status: "new" };
    }
    if (this.getCalls < 2) {
      return { id: dropletId, status: "new" };
    }
    return {
      id: dropletId,
      status: "active",
      publicIpv4: this.opts.noIp ? undefined : this.opts.emptyIp ? "" : "203.0.113.20",
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
  sleep: async () => {},
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_do",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

/**
 * Snapshot-restore-shape fake (task #42): the droplet traces `new|no-ip` →
 * `off|no-ip` → `active|ip`. The transient `off` is the snapshot-copy step;
 * the allocator must NOT classify it as terminal. Each poll yields a distinct
 * structural signature so the convergence detector sees forward motion.
 */
class SnapshotRestoreFakeClient implements DigitalOceanClient {
  private getCalls = 0;
  async createDroplet(): Promise<DigitalOceanDroplet> {
    return { id: 99, status: "new", publicIpv4: undefined };
  }
  async getDroplet(dropletId: number): Promise<DigitalOceanDroplet> {
    this.getCalls += 1;
    if (this.getCalls === 1) return { id: dropletId, status: "new", publicIpv4: undefined };
    if (this.getCalls === 2) return { id: dropletId, status: "off", publicIpv4: undefined };
    return { id: dropletId, status: "active", publicIpv4: "203.0.113.30" };
  }
  async deleteDroplet(): Promise<void> {}
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

  // Task #31: the wait now polls on STRUCTURAL signature progress (no wall-clock
  // deadline). A droplet stuck at `new|no-ip` returns the SAME signature every probe,
  // so the loop crosses the saturation gate and surfaces
  // `PersistentProvisioningOutageError` LOUD (wrapped in the per-allocator typed error
  // with `cause` preserved so the inner stuck-signature + probe-count remain accessible).
  it("surfaces a typed error and destroys the droplet on a stuck-signature fixed point (never becomes active)", async () => {
    const client = new FakeDigitalOceanClient({ neverActive: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_3"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as Error).message).toMatch(/did not become active/u);
    // The cause chain carries the inner convergence-class outage so the stuck
    // signature + probe count remain diagnosable to callers.
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
    expect((caught as { cause: PersistentProvisioningOutageError }).cause.stuckSignature).toBe("new|no-ip");
    expect(client.deleted).toContain(99);
  });

  it("surfaces a typed error and destroys the droplet on a stuck-signature fixed point (no public IP)", async () => {
    const client = new FakeDigitalOceanClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_4"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
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
    ).toThrow(/non-empty apiToken/u);
    expect(
      () =>
        new DigitalOceanAllocator({
          ...baseOpts(new FakeDigitalOceanClient(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/u);
  });

  // waitForActive requires "active" AND a non-empty IPv4. An empty-string IPv4
  // must NOT satisfy the ready condition: a mutant dropping the `ip === ""` arm
  // would return immediately with a bogus empty host. Here it keeps polling and
  // ultimately surfaces the stuck-signature fixed point (active|no-ip), and the
  // droplet is destroyed.
  it("treats an empty-string IPv4 as not-yet-active and destroys on stuck-signature fixed point", async () => {
    const client = new FakeDigitalOceanClient({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_empty"))).rejects.toThrow(/did not become active/u);
    expect(client.deleted).toContain(99);
    expect(runners.claims).toEqual([]);
  });

  it("DigitalOceanAllocatorError carries the DigitalOceanAllocatorError name", () => {
    const error = new DigitalOceanAllocatorError("boom");
    expect(error.name).toBe("DigitalOceanAllocatorError");
    expect(error).toBeInstanceOf(Error);
  });

  // Task #42 — snapshot-restore intermediate `off` is ADVANCING, not terminal.
  // A snapshot-backed droplet traces `new` → `off` → `active`. The previous
  // allowlist (`["off","archive"]`) classified the transient `off` as terminal,
  // false-escalating every snapshot-restore allocation. With `off` moved to
  // {@link DO_PROVISIONING_STATUSES}, the allocator now traces past the
  // transient and resolves to ready when the droplet comes back to `active`.
  it("treats a transient `off` mid-snapshot-restore as advancing (not terminal) and resolves to ready", async () => {
    const client = new SnapshotRestoreFakeClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    const allocation = await allocator.allocate(req("run_snap"));
    expect(allocation.target.host).toBe("203.0.113.30");
    // The mid-restore `off` must NOT have destroyed the droplet (the false-
    // escalation shape #42 names). The droplet that actually resolves to
    // `active` is the same one the run claims.
    expect(runners.claims[0]?.containerId).toBe("99");
  });

  // The droplet tags are the run/project ids, lowercased with disallowed chars
  // replaced. Pin the exact sanitized tag values so the toLowerCase/replace on
  // the tag template is behavior-asserted.
  it("sanitizes run/project ids into lowercase droplet tags", async () => {
    const client = new FakeDigitalOceanClient();
    const allocator = new DigitalOceanAllocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate({
      runId: "Run/AB",
      projectId: "Proj X",
      runnerImage: "img",
      identitySecretRef: "r",
    });
    expect(client.created[0]?.tags).toEqual(["tanren-run-run-ab", "tanren-project-proj-x"]);
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
    expect(captured.url).toMatch(/\/droplets$/u);
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(droplet).toEqual({ id: 7, status: "active", publicIpv4: "198.51.100.9" });
  });

  it("fetchDigitalOceanClient treats a 404 delete as success (idempotent)", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("not found", { status: 404 })) as typeof fetch;
    const client = fetchDigitalOceanClient("secret-token", fetchImpl);
    await expect(client.deleteDroplet(123)).resolves.toBeUndefined();
  });

  it("sanitizes the run id into a lowercase, hyphen-only droplet name", async () => {
    const client = new FakeDigitalOceanClient();
    const allocator = new DigitalOceanAllocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate(req("Run_ABC/1"));
    expect(client.created[0]?.name).toBe("tanren-run-abc-1");
  });

  it("uses the configured SSH username over the default", async () => {
    const client = new FakeDigitalOceanClient();
    const allocator = new DigitalOceanAllocator({
      ...baseOpts(client, new FakeRunnerStore()),
      sshUsername: "operator",
    });
    const allocation = await allocator.allocate(req("run_u"));
    expect(allocation.target.username).toBe("operator");
  });

  it("fetchDigitalOceanClient yields no IP when the droplet has no networks", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ droplet: { id: 8, status: "new" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchDigitalOceanClient("secret-token", fetchImpl);
    const droplet = await client.createDroplet({ name: "n", region: "nyc3", size: "s", image: "i" });
    expect(droplet.publicIpv4).toBeUndefined();
  });

  // publicIpv4Of only accepts a v4 entry whose `type === "public"` AND whose
  // ip_address is non-empty. A private-only address must be ignored. Pin that a
  // private v4 entry yields no IP so the type/empty filter cannot be loosened.
  it("fetchDigitalOceanClient ignores a private-only v4 address", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          droplet: { id: 8, status: "active", networks: { v4: [{ ip_address: "10.0.0.2", type: "private" }] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchDigitalOceanClient("secret-token", fetchImpl);
    const droplet = await client.getDroplet(8);
    expect(droplet.publicIpv4).toBeUndefined();
  });

  // The create body carries the droplet spec (region/size/image) and the run
  // tags. Pin the POSTed body so the JSON.stringify field mapping is asserted.
  it("fetchDigitalOceanClient POSTs the droplet spec and tags in the create body", async () => {
    let captured: { url: string; method?: string; body: Record<string, unknown> } = { url: "", body: {} };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ droplet: { id: 5, status: "new" } }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchDigitalOceanClient("tok", fetchImpl);
    await client.createDroplet({
      name: "tanren-run-1",
      region: "sfo3",
      size: "s-2vcpu-2gb",
      image: "docker-20-04",
      tags: ["tanren-run-run-1"],
    });
    expect(captured.url).toMatch(/\/droplets$/u);
    expect(captured.method).toBe("POST");
    expect(captured.body.region).toBe("sfo3");
    expect(captured.body.size).toBe("s-2vcpu-2gb");
    expect(captured.body.image).toBe("docker-20-04");
    expect(captured.body.tags).toEqual(["tanren-run-run-1"]);
  });

  it("fetchDigitalOceanClient DELETEs the droplet at the droplets path", async () => {
    let captured: { url: string; method?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = { url: typeof input === "string" ? input : input.toString(), method: init?.method };
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const client = fetchDigitalOceanClient("tok", fetchImpl);
    await client.deleteDroplet(777);
    expect(captured.url).toMatch(/\/droplets\/777$/u);
    expect(captured.method).toBe("DELETE");
  });
});

// Task #31: the shared readiness-convergence conformance suite for DigitalOcean
// lives in `digitalOceanAllocator.readinessConformance.test.ts` (split to keep
// each test file under the line cap).
