import { describe, expect, it } from "vitest";
import {
  DigitalOceanAllocator,
  DigitalOceanAllocatorError,
  fetchDigitalOceanClient,
  type DigitalOceanClient,
  type DigitalOceanCreateDropletInput,
  type DigitalOceanDroplet,
} from "../src/engine/allocators/digitalOceanAllocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
} from "../src/engine/allocators/readinessConvergence.js";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { describeReadinessConvergence } from "./conformance/readinessConvergenceConformance.js";

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
    expect(((caught as { cause: PersistentProvisioningOutageError }).cause).stuckSignature).toBe("new|no-ip");
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

// Task #31: the shared readiness-convergence conformance suite. Pins the 4 scenarios
// (advancing-unbounded / stuck-fixed-point / unknown-state-fail-closed / terminal-arms)
// at the per-allocator wiring so a future regression on the classifier, signature, or
// terminal-arm wiring fails CI at the SAME contract every other allocator is held to.
//
// Each per-poll observation `getDroplet` returns is wired into the allocator's
// `pollUntilReady` call. The harness builds an allocator + request whose poll stream
// exercises a single scenario at a time; the allocator-side wrapping converts the
// convergence-class throws into the per-allocator typed `DigitalOceanAllocatorError`
// with the cause preserved, so the conformance checks read the inner discriminator
// off the `.cause` chain.

// Advancing harness: a sequence of CHANGING structural signatures (drives the
// convergence detector forward; the loop must NOT escalate). `getDroplet` walks
// through `new|no-ip` → `new|ip-A` → `new|ip-B` → … → `active|ip` (ready).
class AdvancingFakeDigitalOceanClient implements DigitalOceanClient {
  private getCalls = 0;
  async createDroplet(): Promise<DigitalOceanDroplet> {
    return { id: 99, status: "new", publicIpv4: undefined };
  }
  async getDroplet(dropletId: number): Promise<DigitalOceanDroplet> {
    this.getCalls += 1;
    if (this.getCalls >= 8) {
      return { id: dropletId, status: "active", publicIpv4: "203.0.113.20" };
    }
    // Each probe must yield a DIFFERENT structural signature so the convergence
    // detector sees forward motion. The signature is `${status}|${ip-presence}`
    // — so alternating between IP and no-IP under `new` produces distinct ones,
    // and we toggle to `active` for the last few intermediate steps.
    if (this.getCalls % 2 === 0) {
      return { id: dropletId, status: this.getCalls < 4 ? "new" : "active", publicIpv4: undefined };
    }
    return { id: dropletId, status: this.getCalls < 4 ? "new" : "active", publicIpv4: `intermediate-${this.getCalls}` };
  }
  async deleteDroplet(): Promise<void> {}
}

// The conformance suite hard-asserts that every PROVIDER terminal arm in
// `DO_TERMINAL_STATUSES` fires `ProvisioningTerminalStateError` IMMEDIATELY rather
// than via the fixed-point gate. For DO the documented terminal arms are `off` and
// `archive` (the allocator's `DO_TERMINAL_STATUSES` allowlist).
const harness = {
  buildAdvancing() {
    const client = new AdvancingFakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_adv"), expectedAdvancingProbes: 7 };
  },
  buildStuck() {
    const client = new FakeDigitalOceanClient({ neverActive: true });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    // The createDroplet returns `new|no-ip`; the getDroplet then returns
    // `new|no-ip` forever — that's the stuck signature the loop surfaces.
    return { allocator, request: req("run_stuck"), expectedStuckSignature: "new|no-ip" };
  },
  buildUnknownState() {
    const client = new FakeDigitalOceanClient({ unknownStatus: "rebuilding-from-snapshot-2030" });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_unk"), expectedUnknownState: "rebuilding-from-snapshot-2030" };
  },
  buildTerminalArm(terminalState: string) {
    const client = new FakeDigitalOceanClient({ terminalStatus: terminalState });
    const runners = new FakeRunnerStore();
    const allocator = new DigitalOceanAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_term") };
  },
  // DO's documented terminal statuses — the allocator's `DO_TERMINAL_STATUSES`
  // allowlist. Each fires `ProvisioningTerminalStateError` IMMEDIATELY.
  expectedTerminalArms: ["off", "archive"] as const,
};

// Adapter: the readiness-convergence conformance harness asserts the INNER
// convergence-class error directly, but DigitalOceanAllocator wraps it into the
// per-allocator typed `DigitalOceanAllocatorError` (so callers see a uniform
// allocator error). The conformance suite's `instanceof` checks read the inner
// surface off `.cause`, but for DO we also re-pin the inner contract here, since
// the wrapper has its own per-allocator phrasing the suite does not assert.
describe("DigitalOceanAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as DigitalOceanAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as DigitalOceanAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as DigitalOceanAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildTerminalArm("off");
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

// The shared 4-scenario conformance contract. The cause-chain adapter above
// translates the wrapped DigitalOceanAllocatorError into the inner convergence
// types this conformance harness reads, so the suite asserts the contract at
// the same seam every other allocator is held to.
describeReadinessConvergence("DigitalOcean", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return {
      allocator: wrapAllocatorErrorAsConvergence(inner.allocator),
      request: inner.request,
      expectedAdvancingProbes: inner.expectedAdvancingProbes,
    };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return {
      allocator: wrapAllocatorErrorAsConvergence(inner.allocator),
      request: inner.request,
      expectedStuckSignature: inner.expectedStuckSignature,
    };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return {
      allocator: wrapAllocatorErrorAsConvergence(inner.allocator),
      request: inner.request,
      expectedUnknownState: inner.expectedUnknownState,
    };
  },
  buildTerminalArm: (terminalState: string) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { allocator: wrapAllocatorErrorAsConvergence(inner.allocator), request: inner.request };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});

/**
 * Adapter: unwrap the per-allocator `DigitalOceanAllocatorError` back to its
 * `cause` (the original convergence-class error from `pollUntilReady`) so the
 * shared conformance harness's `instanceof` checks read the inner surface.
 * This preserves both contracts: existing callers see the typed allocator error,
 * and the conformance suite asserts the same convergence-class behavior across
 * every allocator at the SAME seam.
 */
function wrapAllocatorErrorAsConvergence(allocator: Allocator): Allocator {
  return {
    async allocate(request) {
      try {
        return await allocator.allocate(request);
      } catch (error) {
        if (error instanceof DigitalOceanAllocatorError && error.cause !== undefined) {
          throw error.cause;
        }
        throw error;
      }
    },
    release: allocator.release.bind(allocator),
  };
}
