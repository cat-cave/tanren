// Per-implementation invocations of the Allocator conformance suite. Every
// concrete allocator is run through the SAME behavior spec
// (`describeAllocatorConformance`) with its own factory + injected mock client,
// and every allocator with an injectable failure path is also run through
// `describeAllocatorFailureConformance`. This is the "slottable implementation"
// enabler: a new allocator (or a future Rust impl via its test shim) gets
// contract coverage by adding one entry here. The mock clients below model
// only the happy-path lifecycle each allocator needs (provision -> running+IP
// -> destroy); each accepts a `fail` flag for the never-ready variant.
import { FakeAllocator, type AllocationRequest, type Allocator } from "../../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type {
  ClaimRunnerInput,
  PoolLeaseReleaseOutcome,
  PoolLeaseReservation,
  ReleasePoolLeaseInput,
  ReservePoolLeaseInput,
  RunnerPoolLeaseStore,
  RunnerStore,
} from "../../src/engine/allocators/runnerStore.js";
import { StaticRunnerAllocator } from "../../src/engine/allocators/staticRunnerAllocator.js";
import { ManualSshAllocator } from "../../src/engine/allocators/manualSshAllocator.js";
import { SidecarHttpAllocator } from "../../src/engine/allocators/sidecarHttpAllocator.js";
import { HetznerAllocator, type HetznerClient } from "../../src/engine/allocators/hetznerAllocator.js";
import { generateEd25519KeyPair } from "../../src/engine/ssh/keygen.js";
import { DigitalOceanAllocator, type DigitalOceanClient } from "../../src/engine/allocators/digitalOceanAllocator.js";
import { GcpAllocator, type GcpComputeClient } from "../../src/engine/allocators/gcpAllocator.js";
import { AwsEc2Allocator, type AwsEc2Client } from "../../src/engine/allocators/awsEc2Allocator.js";
import { KubernetesAllocator, type KubernetesClient } from "../../src/engine/allocators/kubernetesAllocator.js";
import { describeAllocatorConformance, describeAllocatorFailureConformance } from "./allocatorConformance.js";

/**
 * Minimal in-memory scaffolding shared by the impls under test. Implements BOTH
 * the {@link RunnerStore} mirror (cloud/static/sidecar impls) AND the
 * {@link RunnerPoolLeaseStore} reservation seam (the manual-ssh fixed pool) so one
 * fake backs every allocator kind. The lease side models the shared store's
 * contract: one live lease per (poolKey, leaseKey), the `maxConcurrent` cap, and
 * a fenced (owner + token) release.
 */
class MemoryRunnerStore implements RunnerStore, RunnerPoolLeaseStore {
  private readonly claimed = new Map<string, ClaimRunnerInput>();
  private readonly leases = new Map<string, Map<string, { runnerId: string; owner: string; token: string }>>();
  private readonly byRunner = new Map<string, { poolKey: string; leaseKey: string }>();
  private nextToken = 1;
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claimed.set(input.runnerId, input);
  }
  async release(runnerId: string): Promise<void> {
    this.claimed.delete(runnerId);
  }
  /**
   * Codex H3 #13: simulates the persisted-DB fallback the cold-start release
   * path reads. Returns the metadata captured at claim time; a released row
   * has been deleted from `claimed` so it correctly returns `undefined`.
   */
  async readTeardownDescriptor(runnerId: string) {
    return this.claimed.get(runnerId)?.providerMetadata ?? undefined;
  }
  private poolMap(poolKey: string): Map<string, { runnerId: string; owner: string; token: string }> {
    let map = this.leases.get(poolKey);
    if (map === undefined) {
      map = new Map();
      this.leases.set(poolKey, map);
    }
    return map;
  }
  async reservePoolLease(input: ReservePoolLeaseInput): Promise<PoolLeaseReservation> {
    const pool = this.poolMap(input.poolKey);
    // Plain Errors here (not the typed lease errors) keep this module's
    // `runnerStore.js` import TYPE-ONLY — the conformance failure case only needs
    // allocate() to reject when the single-host pool is exhausted; the typed-error
    // fidelity is proven in manualSshAllocator.test.ts + the RLS integration test.
    if (input.maxConcurrent !== undefined && pool.size >= input.maxConcurrent) {
      throw new Error(`pool ${input.poolKey} at capacity ${input.maxConcurrent}`);
    }
    const chosen = input.candidates.find((candidate) => !pool.has(candidate.leaseKey));
    if (chosen === undefined) {
      throw new Error(`pool ${input.poolKey} exhausted`);
    }
    const token = String(this.nextToken++);
    pool.set(chosen.leaseKey, { runnerId: input.runnerId, owner: input.owner, token });
    this.byRunner.set(input.runnerId, { poolKey: input.poolKey, leaseKey: chosen.leaseKey });
    return { ...chosen, owner: input.owner, fencingToken: token };
  }
  async releasePoolLease(input: ReleasePoolLeaseInput): Promise<PoolLeaseReleaseOutcome> {
    const where = this.byRunner.get(input.runnerId);
    if (where === undefined) return { released: false };
    const record = this.poolMap(where.poolKey).get(where.leaseKey);
    if (record === undefined || record.runnerId !== input.runnerId) return { released: false };
    if (record.owner !== input.owner || record.token !== input.fencingToken) {
      throw new Error(`stale release of ${input.runnerId}`);
    }
    this.poolMap(where.poolKey).delete(where.leaseKey);
    this.byRunner.delete(input.runnerId);
    return { released: true };
  }
}

function request(runId: string): AllocationRequest {
  return {
    runId,
    projectId: "proj_conformance",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const PINNED_FINGERPRINT = "SHA256:cccccccccccccccccccccccccccccccccccccccccccc";
const noSleep = async (): Promise<void> => undefined;
const slowReady = { sleep: noSleep, readyTimeoutMs: 5, pollIntervalMs: 1 } as const;

// --- Mock cloud clients (happy path; `fail` -> never reaches ready) ---------
function hetznerClient(fail = false): HetznerClient {
  let polls = 0;
  return {
    async createSshKey(): Promise<{ id: number }> {
      return { id: 1 };
    },
    async deleteSshKey(): Promise<void> {},
    async createServer(): Promise<{ id: number; status: string }> {
      return { id: 1, status: "initializing" };
    },
    async getServer(id: number): Promise<{ id: number; status: string; publicIpv4?: string }> {
      polls += 1;
      return fail || polls < 2 ? { id, status: "initializing" } : { id, status: "running", publicIpv4: "203.0.113.10" };
    },
    async deleteServer(): Promise<void> {},
  };
}

function digitalOceanClient(fail = false): DigitalOceanClient {
  let polls = 0;
  return {
    async createDroplet(): Promise<{ id: number; status: string }> {
      return { id: 2, status: "new" };
    },
    async getDroplet(id: number): Promise<{ id: number; status: string; publicIpv4?: string }> {
      polls += 1;
      return fail || polls < 2 ? { id, status: "new" } : { id, status: "active", publicIpv4: "203.0.113.20" };
    },
    async deleteDroplet(): Promise<void> {},
  };
}

function gcpClient(fail = false): GcpComputeClient {
  let polls = 0;
  return {
    async insertInstance(): Promise<{ name: string; status: string }> {
      return { name: "op-1", status: "RUNNING" };
    },
    async getZoneOperation(name: string): Promise<{ name: string; status: string }> {
      return { name, status: "DONE" };
    },
    async getInstance(name: string): Promise<{ name: string; status: string; externalIp?: string }> {
      polls += 1;
      return fail || polls < 2
        ? { name, status: "PROVISIONING" }
        : { name, status: "RUNNING", externalIp: "203.0.113.50" };
    },
    async deleteInstance(): Promise<void> {},
  };
}

function awsClient(fail = false): AwsEc2Client {
  let polls = 0;
  return {
    async runInstances(): Promise<{ instanceId: string; state: string }> {
      return { instanceId: "i-1", state: "pending" };
    },
    async describeInstance(instanceId: string): Promise<{ instanceId: string; state: string; publicIp?: string }> {
      polls += 1;
      return fail || polls < 2
        ? { instanceId, state: "pending" }
        : { instanceId, state: "running", publicIp: "203.0.113.7" };
    },
    async terminateInstance(): Promise<void> {},
  };
}

function kubernetesClient(fail = false): KubernetesClient {
  let polls = 0;
  return {
    async createSecret(): Promise<void> {},
    async createPod(input: { name: string }): Promise<{ name: string; phase: string }> {
      return { name: input.name, phase: "Pending" };
    },
    async getPod(name: string): Promise<{ name: string; phase: string; podIp?: string }> {
      polls += 1;
      return fail || polls < 2 ? { name, phase: "Pending" } : { name, phase: "Running", podIp: "10.1.2.3" };
    },
    async deletePod(): Promise<void> {},
    async deleteSecret(): Promise<void> {},
  };
}

/** In-memory `fetch` for the sidecar allocator: /allocate -> target, /release -> released. */
function sidecarFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/allocate")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        runId: string;
      };
      return new Response(
        JSON.stringify({
          runnerId: `runner_${body.runId}`,
          sshHost: "tanren-runner",
          sshPort: 22,
          hostKeyFingerprint: PINNED_FINGERPRINT,
          imageSha: "ghcr.io/cat-cave/tanren-runner@sha256:sidecar",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ released: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// --- Per-impl allocator factories -------------------------------------------
const makeStatic = (): Allocator =>
  new StaticRunnerAllocator({
    host: "runner",
    port: 22,
    hostKeyFingerprint: PINNED_FINGERPRINT,
    runners: new MemoryRunnerStore(),
  });

const makeManual = (): Allocator =>
  new ManualSshAllocator({
    hosts: [{ id: "host-1", host: "10.0.0.1", hostKeyFingerprint: PINNED_FINGERPRINT }],
    leases: new MemoryRunnerStore(),
  });

const makeSidecar = (): Allocator =>
  new SidecarHttpAllocator({
    baseUrl: "http://allocator:3200",
    authToken: "token",
    runners: new MemoryRunnerStore(),
    fetchImpl: sidecarFetch(),
    sshUsername: "tanren",
  });

// Inject a DETERMINISTIC, pre-generated well-formed keypair so the Hetzner
// conformance run can never flake on the (now-retry-hardened) live generator.
// One real ed25519 keypair, generated once at module load, reused for both the
// client + host key slots — the conformance suite only asserts the SHA256
// fingerprint SHAPE, not uniqueness.
const CONFORMANCE_KEYPAIR = generateEd25519KeyPair();
const makeHetzner = (fail = false): Allocator =>
  new HetznerAllocator({
    apiToken: "tok",
    serverType: "cx22",
    image: "docker-ce",
    runners: new MemoryRunnerStore(),
    secrets: new InMemorySecretStore(),
    client: hetznerClient(fail),
    generateKeyPair: () => CONFORMANCE_KEYPAIR,
    ...slowReady,
  });

const makeDigitalOcean = (fail = false): Allocator =>
  new DigitalOceanAllocator({
    apiToken: "tok",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    region: "nyc3",
    size: "s-1vcpu-1gb",
    image: "docker-20-04",
    runners: new MemoryRunnerStore(),
    client: digitalOceanClient(fail),
    ...slowReady,
  });

const makeGcp = (fail = false): Allocator =>
  new GcpAllocator({
    accessToken: "tok",
    project: "proj",
    zone: "us-central1-a",
    machineType: "e2-small",
    sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
    sshUsername: "tanren",
    sshPublicKey: "ssh-ed25519 AAAA",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    runners: new MemoryRunnerStore(),
    client: gcpClient(fail),
    ...slowReady,
  });

const makeAws = (fail = false): Allocator =>
  new AwsEc2Allocator({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    region: "us-east-1",
    imageId: "ami-0abcd1234",
    instanceType: "t3.small",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    sshUsername: "ec2-user",
    runners: new MemoryRunnerStore(),
    client: awsClient(fail),
    ...slowReady,
  });

const makeKubernetes = (fail = false): Allocator =>
  new KubernetesAllocator({
    apiServer: "https://10.0.0.1:6443",
    token: "sa-token",
    namespace: "tanren",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    sshPublicKey: "ssh-ed25519 AAAA",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    sshUsername: "tanren",
    runners: new MemoryRunnerStore(),
    client: kubernetesClient(fail),
    ...slowReady,
  });

// --- Contract conformance (all 9 impls) -------------------------------------
// The `expectedTaxonomy` per impl is the SEAM the reclassification rides on
// (Codex H3 #14/#15/#16): fixed_pool for static + manual_ssh (lease-only, no
// destroy), delegated for sidecar (the sidecar service owns lifecycle), and
// provisioning for every real cloud kind (allocate creates + release destroys
// an underlying resource). FakeAllocator is fixed_pool by design — its
// `release()` is a no-op, matching lease semantics.
describeAllocatorConformance("FakeAllocator", {
  make: (): Allocator => new FakeAllocator(),
  request,
  expectedTaxonomy: "fixed_pool",
});
describeAllocatorConformance("StaticRunnerAllocator", {
  make: makeStatic,
  request,
  expectedTaxonomy: "fixed_pool",
});
describeAllocatorConformance("ManualSshAllocator", {
  make: makeManual,
  request,
  expectedTaxonomy: "fixed_pool",
});
describeAllocatorConformance("SidecarHttpAllocator", {
  make: makeSidecar,
  request,
  expectedTaxonomy: "delegated",
});
describeAllocatorConformance("HetznerAllocator", {
  make: (): Allocator => makeHetzner(),
  request,
  expectedTaxonomy: "provisioning",
});
describeAllocatorConformance("DigitalOceanAllocator", {
  make: (): Allocator => makeDigitalOcean(),
  request,
  expectedTaxonomy: "provisioning",
});
describeAllocatorConformance("GcpAllocator", {
  make: (): Allocator => makeGcp(),
  request,
  expectedTaxonomy: "provisioning",
});
describeAllocatorConformance("AwsEc2Allocator", {
  make: (): Allocator => makeAws(),
  request,
  expectedTaxonomy: "provisioning",
});
describeAllocatorConformance("KubernetesAllocator", {
  make: (): Allocator => makeKubernetes(),
  request,
  expectedTaxonomy: "provisioning",
});

// --- Failure conformance (impls with an injectable failure path) ------------
describeAllocatorFailureConformance("ManualSshAllocator", {
  // A one-host pool already leased forces the next allocate() to fail.
  makeFailing: () => {
    const allocator = makeManual();
    void allocator.allocate(request("conf_fail_seed"));
    return { allocator, request: request("conf_fail_second") };
  },
});
describeAllocatorFailureConformance("HetznerAllocator", {
  makeFailing: () => ({ allocator: makeHetzner(true), request: request("conf_fail") }),
});
describeAllocatorFailureConformance("DigitalOceanAllocator", {
  makeFailing: () => ({ allocator: makeDigitalOcean(true), request: request("conf_fail") }),
});
describeAllocatorFailureConformance("GcpAllocator", {
  makeFailing: () => ({ allocator: makeGcp(true), request: request("conf_fail") }),
});
describeAllocatorFailureConformance("AwsEc2Allocator", {
  makeFailing: () => ({ allocator: makeAws(true), request: request("conf_fail") }),
});
describeAllocatorFailureConformance("KubernetesAllocator", {
  makeFailing: () => ({ allocator: makeKubernetes(true), request: request("conf_fail") }),
});
