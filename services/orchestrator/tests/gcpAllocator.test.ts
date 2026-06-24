import { describe, expect, it } from "vitest";
import {
  fetchGcpComputeClient,
  GcpAllocator,
  GcpAllocatorError,
  type GcpComputeClient,
  type GcpInsertInstanceInput,
  type GcpInstance,
  type GcpOperation,
} from "../src/engine/allocators/gcpAllocator.js";
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

/**
 * Mocked GCP API: insert returns a RUNNING op that goes DONE on the next poll;
 * the instance is PROVISIONING then RUNNING with an external IP.
 */
class FakeGcpComputeClient implements GcpComputeClient {
  readonly inserted: GcpInsertInstanceInput[] = [];
  readonly deleted: string[] = [];
  private getCalls = 0;
  constructor(
    private readonly opts: {
      opError?: string;
      neverRunning?: boolean;
      noIp?: boolean;
      emptyIp?: boolean;
      /** Pin a brand-new unrecognized instance status the allowlist doesn't know. */
      unknownStatus?: string;
      /** Pin a documented instance terminal status (TERMINATED / STOPPED / …). */
      terminalStatus?: string;
    } = {},
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
    if (this.opts.unknownStatus !== undefined) {
      return { name: instanceName, status: this.opts.unknownStatus };
    }
    if (this.opts.terminalStatus !== undefined) {
      return { name: instanceName, status: this.opts.terminalStatus };
    }
    if (this.opts.neverRunning) {
      return { name: instanceName, status: "PROVISIONING" };
    }
    if (this.getCalls < 2) {
      return { name: instanceName, status: "PROVISIONING" };
    }
    return {
      name: instanceName,
      status: "RUNNING",
      externalIp: this.opts.noIp ? undefined : this.opts.emptyIp ? "" : "203.0.113.50",
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
  sleep: async () => {},
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_gcp",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
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

  // Task #31: the wait now polls on STRUCTURAL signature progress (no wall-clock
  // deadline). The GCP operation's `error` field fires the `terminal_error` arm
  // IMMEDIATELY (the cloud reported the failure once the operation poll surfaces
  // the error string); the wrapping preserves the `cause`.
  it("surfaces a typed error and deletes the instance when the op reports an error", async () => {
    const client = new FakeGcpComputeClient({ opError: "QUOTA_EXCEEDED" });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_e"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
    expect((caught as Error).message).toContain("QUOTA_EXCEEDED");
    expect(client.deleted).toContain("tanren-run-e");
  });

  it("surfaces a typed error and deletes the instance on a stuck-signature fixed point (never becomes RUNNING)", async () => {
    const client = new FakeGcpComputeClient({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_3"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as Error).message).toMatch(/did not become RUNNING/u);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
    expect(((caught as { cause: PersistentProvisioningOutageError }).cause).stuckSignature).toBe("PROVISIONING|no-ip");
    expect(client.deleted).toContain("tanren-run-3");
  });

  it("surfaces a typed error and deletes the instance on a stuck-signature fixed point (no external IP)", async () => {
    const client = new FakeGcpComputeClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    let caught: unknown;
    try {
      await allocator.allocate(req("run_4"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
    expect(client.deleted).toContain("tanren-run-4");
  });

  it("sanitizes and truncates the run id into a <=62 char instance name", async () => {
    const client = new FakeGcpComputeClient();
    const allocator = new GcpAllocator(baseOpts(client, new FakeRunnerStore()));
    const longRunId = "RUN_" + "X".repeat(80);
    await allocator.allocate(req(longRunId));
    const name = client.inserted[0]!.name;
    expect(name.length).toBe(62);
    expect(name).toMatch(/^tanren-run-x+$/u);
    // Uppercase + underscore are normalized to lowercase + hyphen.
    expect(name).not.toMatch(/[^a-z0-9-]/u);
  });

  it("sanitizes label values to the gcp-allowed charset", async () => {
    const client = new FakeGcpComputeClient();
    const allocator = new GcpAllocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate(req("Run/With.Dots"));
    const runLabel = client.inserted[0]!.labels?.["tanren-run"];
    // labelValue lowercases and replaces anything outside [a-z0-9_-] with "-".
    expect(runLabel).toBe("run-with-dots");
  });

  it("honors a configured SSH username override on the returned target", async () => {
    const client = new FakeGcpComputeClient();
    const allocation = await new GcpAllocator({
      ...baseOpts(client, new FakeRunnerStore()),
      sshUsername: "operator",
    }).allocate(req("run_ov"));
    expect(allocation.target.username).toBe("operator");
  });

  it("requires a token, ssh public key, and pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    expect(() => new GcpAllocator({ ...baseOpts(new FakeGcpComputeClient(), runners), accessToken: "" })).toThrow(
      /non-empty accessToken/u,
    );
    expect(() => new GcpAllocator({ ...baseOpts(new FakeGcpComputeClient(), runners), sshPublicKey: "" })).toThrow(
      /non-empty sshPublicKey/u,
    );
    expect(
      () =>
        new GcpAllocator({
          ...baseOpts(new FakeGcpComputeClient(), runners),
          hostKeyFingerprint: "",
        }),
    ).toThrow(/pinned hostKeyFingerprint/u);
  });

  // waitForRunning requires RUNNING AND a non-empty external IP. An empty-string
  // IP must NOT satisfy the ready condition: a mutant dropping the `ip === ""`
  // arm would return immediately with a bogus empty host. Here the empty IP
  // keeps the wait polling and ultimately surfaces the stuck-signature fixed
  // point (`RUNNING|no-ip`), and the instance is deleted.
  it("treats an empty-string external IP as not-yet-ready and deletes on stuck-signature fixed point", async () => {
    const client = new FakeGcpComputeClient({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    await expect(allocator.allocate(req("run_empty"))).rejects.toThrow(/did not become RUNNING/u);
    expect(client.deleted).toContain("tanren-run-empty");
    expect(runners.claims).toEqual([]);
  });

  // The error subclass sets a distinct `.name`; pin it so a blanked-name mutant
  // (which survives a bare instanceof check) is caught.
  it("GcpAllocatorError carries the GcpAllocatorError name", () => {
    const error = new GcpAllocatorError("boom");
    expect(error.name).toBe("GcpAllocatorError");
    expect(error).toBeInstanceOf(Error);
  });

  it("fetchGcpComputeClient maps the instance response and sends the bearer token", async () => {
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
          name: "tanren-x",
          status: "RUNNING",
          networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "198.51.100.42" }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = fetchGcpComputeClient(
      { accessToken: "secret-token", project: "p", zone: "us-central1-a" },
      fetchImpl,
    );
    const instance = await client.getInstance("tanren-x");
    expect(captured.url).toMatch(/\/projects\/p\/zones\/us-central1-a\/instances\/tanren-x$/u);
    expect(captured.method).toBe("GET");
    expect(captured.auth).toBe("Bearer secret-token");
    expect(instance).toEqual({ name: "tanren-x", status: "RUNNING", externalIp: "198.51.100.42" });
  });

  it("fetchGcpComputeClient builds the insert request body (machine type, boot disk, NAT, ssh-keys metadata)", async () => {
    let captured: { url: string; method?: string; body: Record<string, unknown> } = { url: "", body: {} };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ name: "op-1", status: "RUNNING" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = fetchGcpComputeClient({ accessToken: "t", project: "proj-x", zone: "europe-west1-b" }, fetchImpl);
    await client.insertInstance({
      name: "tanren-run-1",
      machineType: "e2-medium",
      sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
      sshUsername: "tanren",
      sshPublicKey: "ssh-ed25519 KEY",
      labels: { "tanren-run": "run-1" },
    });

    expect(captured.url).toMatch(/\/projects\/proj-x\/zones\/europe-west1-b\/instances$/u);
    expect(captured.method).toBe("POST");
    // machineType is rendered as a zone-qualified path.
    expect(captured.body.machineType).toBe("zones/europe-west1-b/machineTypes/e2-medium");
    expect(captured.body.labels).toEqual({ "tanren-run": "run-1" });

    const disks = captured.body.disks as Array<Record<string, unknown>>;
    expect(disks).toHaveLength(1);
    expect(disks[0]).toMatchObject({ boot: true, autoDelete: true });
    expect((disks[0]!.initializeParams as Record<string, unknown>).sourceImage).toBe(
      "projects/cos-cloud/global/images/family/cos-stable",
    );

    const networkInterfaces = captured.body.networkInterfaces as Array<Record<string, unknown>>;
    const accessConfigs = networkInterfaces[0]!.accessConfigs as Array<Record<string, unknown>>;
    expect(accessConfigs[0]).toMatchObject({ type: "ONE_TO_ONE_NAT", name: "External NAT" });

    const items = (captured.body.metadata as { items: Array<{ key: string; value: string }> }).items;
    const sshKeys = items.find((item) => item.key === "ssh-keys");
    // The ssh-keys metadata is "<username>:<publickey>".
    expect(sshKeys?.value).toBe("tanren:ssh-ed25519 KEY");
  });

  it("fetchGcpComputeClient surfaces operation errors from the insert response", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          name: "op-9",
          status: "DONE",
          error: { errors: [{ message: "ZONE_RESOURCE_POOL_EXHAUSTED" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const op = await client.insertInstance({
      name: "n",
      machineType: "e2-small",
      sourceImage: "img",
      sshUsername: "tanren",
      sshPublicKey: "ssh-ed25519 AAAA",
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

  // operationErrorOf joins every error message with "; " and falls back to
  // "unknown error" for an error entry that has no message. Pin both so the
  // join separator and the per-entry default are behavior-asserted.
  it("fetchGcpComputeClient joins multiple operation errors and defaults a missing message", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          name: "op-multi",
          status: "DONE",
          error: { errors: [{ message: "QUOTA_EXCEEDED" }, {}] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const op = await client.getZoneOperation("op-multi");
    expect(op.error).toBe("QUOTA_EXCEEDED; unknown error");
  });

  // An operation with an empty `errors` array has no error at all (the length
  // guard returns undefined). A mutant flipping that guard would surface a
  // spurious error string.
  it("fetchGcpComputeClient reports no error for an empty errors array", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ name: "op-ok", status: "DONE", error: { errors: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const op = await client.getZoneOperation("op-ok");
    expect(op.error).toBeUndefined();
  });

  // externalIpOf scans interfaces in order and skips access-configs whose natIP
  // is empty/absent, returning the first non-empty one. Pin: an empty natIP on
  // the first interface is skipped and the second interface's IP wins.
  it("fetchGcpComputeClient skips an empty natIP and finds the IP on a later interface", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          name: "tanren-x",
          status: "RUNNING",
          networkInterfaces: [
            { accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "" }] },
            { accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "198.51.100.77" }] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const instance = await client.getInstance("tanren-x");
    expect(instance.externalIp).toBe("198.51.100.77");
  });

  it("fetchGcpComputeClient yields no external IP when the instance has no network interfaces", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ name: "tanren-x", status: "PROVISIONING" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "z" }, fetchImpl);
    const instance = await client.getInstance("tanren-x");
    expect(instance.externalIp).toBeUndefined();
  });

  // getZoneOperation and deleteInstance must hit the zone-scoped operations /
  // instances paths with the right HTTP verb. Pin the URL + method so the path
  // template and the GET/DELETE literals are behavior-asserted.
  it("fetchGcpComputeClient GETs the zone operation at the operations path", async () => {
    let captured: { url: string; method?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = { url: typeof input === "string" ? input : input.toString(), method: init?.method };
      return new Response(JSON.stringify({ name: "op-1", status: "DONE" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "p", zone: "europe-west1-b" }, fetchImpl);
    await client.getZoneOperation("op-1");
    expect(captured.url).toMatch(/\/projects\/p\/zones\/europe-west1-b\/operations\/op-1$/u);
    expect(captured.method).toBe("GET");
  });

  it("fetchGcpComputeClient DELETEs the instance at the instances path", async () => {
    let captured: { url: string; method?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = { url: typeof input === "string" ? input : input.toString(), method: init?.method };
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = fetchGcpComputeClient({ accessToken: "t", project: "proj-d", zone: "us-central1-a" }, fetchImpl);
    await client.deleteInstance("tanren-run-x");
    expect(captured.url).toMatch(/\/projects\/proj-d\/zones\/us-central1-a\/instances\/tanren-run-x$/u);
    expect(captured.method).toBe("DELETE");
  });
});

// Task #31: shared readiness-convergence conformance suite.
//
// The advancing harness threads CHANGING instance statuses across probes
// (PROVISIONING → STAGING → RUNNING|no-ip → RUNNING|ip). The stuck harness pins
// `PROVISIONING|no-ip`. The conformance suite asserts the contract at the SAME
// seam every other allocator is held to.

/** Each probe yields a NEW structural signature → loop runs unbounded → ready hit. */
class AdvancingFakeGcpComputeClient implements GcpComputeClient {
  private getCalls = 0;
  async insertInstance(): Promise<GcpOperation> {
    return { name: "op-adv", status: "DONE" };
  }
  async getZoneOperation(): Promise<GcpOperation> {
    return { name: "op-adv", status: "DONE" };
  }
  async getInstance(instanceName: string): Promise<GcpInstance> {
    this.getCalls += 1;
    if (this.getCalls >= 8) {
      return { name: instanceName, status: "RUNNING", externalIp: "203.0.113.50" };
    }
    // Cycle PROVISIONING → STAGING → RUNNING|no-ip with distinct IP slugs so the
    // signature advances forward across every intermediate probe.
    const status = this.getCalls < 3 ? "PROVISIONING" : this.getCalls < 5 ? "STAGING" : "RUNNING";
    const externalIp = this.getCalls % 2 === 0 ? undefined : `intermediate-${this.getCalls}`;
    return { name: instanceName, status, externalIp };
  }
  async deleteInstance(): Promise<void> {}
}

const gcpHarness = {
  buildAdvancing() {
    const client = new AdvancingFakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_adv"), expectedAdvancingProbes: 7 };
  },
  buildStuck() {
    const client = new FakeGcpComputeClient({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_stuck"), expectedStuckSignature: "PROVISIONING|no-ip" };
  },
  buildUnknownState() {
    const client = new FakeGcpComputeClient({ unknownStatus: "RECONCILING-NEW-FEATURE" });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_unk"), expectedUnknownState: "RECONCILING-NEW-FEATURE" };
  },
  buildTerminalArm(terminalState: string) {
    const client = new FakeGcpComputeClient({ terminalStatus: terminalState });
    const runners = new FakeRunnerStore();
    const allocator = new GcpAllocator({ ...baseOpts(client, runners), pollIntervalMs: 1 });
    return { allocator, request: req("run_term") };
  },
  // GCP `GCP_INSTANCE_TERMINAL_STATUSES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["STOPPING", "STOPPED", "SUSPENDING", "SUSPENDED", "TERMINATED"] as const,
};

describe("GcpAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = gcpHarness.buildStuck();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = gcpHarness.buildUnknownState();
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = gcpHarness.buildTerminalArm("TERMINATED");
    let caught: unknown;
    try {
      await allocator.allocate(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

function unwrapGcp(allocator: Allocator): Allocator {
  return {
    async allocate(request) {
      try {
        return await allocator.allocate(request);
      } catch (error) {
        if (error instanceof GcpAllocatorError && error.cause !== undefined) {
          throw error.cause;
        }
        throw error;
      }
    },
    release: allocator.release.bind(allocator),
  };
}

describeReadinessConvergence("Gcp", {
  buildAdvancing: () => {
    const inner = gcpHarness.buildAdvancing();
    return { ...inner, allocator: unwrapGcp(inner.allocator) };
  },
  buildStuck: () => {
    const inner = gcpHarness.buildStuck();
    return { ...inner, allocator: unwrapGcp(inner.allocator) };
  },
  buildUnknownState: () => {
    const inner = gcpHarness.buildUnknownState();
    return { ...inner, allocator: unwrapGcp(inner.allocator) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = gcpHarness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapGcp(inner.allocator) };
  },
  expectedTerminalArms: gcpHarness.expectedTerminalArms,
});
