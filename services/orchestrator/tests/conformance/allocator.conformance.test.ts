// Per-implementation invocations of the Allocator conformance suite. Every
// concrete allocator is run through the SAME behavior spec
// (`describeAllocatorConformance`) with its own factory + injected mock client,
// and every allocator with an injectable failure path is also run through
// `describeAllocatorFailureConformance`. This is the "slottable implementation"
// enabler: a new allocator (or a future Rust impl via its test shim) gets
// contract coverage by adding one entry here. The mock clients below model
// only the happy-path lifecycle each allocator needs (provision -> running+IP
// -> destroy); each accepts a `fail` flag for the never-ready variant.
import { FakeAllocator } from "../../src/engine/contracts/allocator.js";
import type { AllocationRequest, Allocator } from "../../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { ClaimRunnerInput, RunnerStore } from "../../src/engine/allocators/runnerStore.js";
import { StaticRunnerAllocator } from "../../src/engine/allocators/staticRunnerAllocator.js";
import { ManualSshAllocator } from "../../src/engine/allocators/manualSshAllocator.js";
import { SidecarHttpAllocator } from "../../src/engine/allocators/sidecarHttpAllocator.js";
import { HetznerAllocator, type HetznerClient } from "../../src/engine/allocators/hetznerAllocator.js";
import { DigitalOceanAllocator, type DigitalOceanClient } from "../../src/engine/allocators/digitalOceanAllocator.js";
import { GcpAllocator, type GcpComputeClient } from "../../src/engine/allocators/gcpAllocator.js";
import { AwsEc2Allocator, type AwsEc2Client } from "../../src/engine/allocators/awsEc2Allocator.js";
import { KubernetesAllocator, type KubernetesClient } from "../../src/engine/allocators/kubernetesAllocator.js";
import { describeAllocatorConformance, describeAllocatorFailureConformance } from "./allocatorConformance.js";

/** Minimal in-memory RunnerStore scaffolding shared by the impls under test. */
class MemoryRunnerStore implements RunnerStore {
  private readonly claimed = new Map<string, ClaimRunnerInput>();
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claimed.set(input.runnerId, input);
  }
  async release(runnerId: string): Promise<void> {
    this.claimed.delete(runnerId);
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
    runners: new MemoryRunnerStore(),
  });

const makeSidecar = (): Allocator =>
  new SidecarHttpAllocator({
    baseUrl: "http://allocator:3200",
    authToken: "token",
    runners: new MemoryRunnerStore(),
    fetchImpl: sidecarFetch(),
    sshUsername: "tanren",
  });

const makeHetzner = (fail = false): Allocator =>
  new HetznerAllocator({
    apiToken: "tok",
    serverType: "cx22",
    image: "docker-ce",
    runners: new MemoryRunnerStore(),
    secrets: new InMemorySecretStore(),
    client: hetznerClient(fail),
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
describeAllocatorConformance("FakeAllocator", {
  make: (): Allocator => new FakeAllocator(),
  request,
});
describeAllocatorConformance("StaticRunnerAllocator", { make: makeStatic, request });
describeAllocatorConformance("ManualSshAllocator", { make: makeManual, request });
describeAllocatorConformance("SidecarHttpAllocator", { make: makeSidecar, request });
describeAllocatorConformance("HetznerAllocator", { make: (): Allocator => makeHetzner(), request });
describeAllocatorConformance("DigitalOceanAllocator", {
  make: (): Allocator => makeDigitalOcean(),
  request,
});
describeAllocatorConformance("GcpAllocator", { make: (): Allocator => makeGcp(), request });
describeAllocatorConformance("AwsEc2Allocator", { make: (): Allocator => makeAws(), request });
describeAllocatorConformance("KubernetesAllocator", {
  make: (): Allocator => makeKubernetes(),
  request,
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
