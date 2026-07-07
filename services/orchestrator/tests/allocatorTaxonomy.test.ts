// Reclassification invariants for the allocator catalog (Codex H3 #14/#15/#16).
//
// The `allocator` interface historically fused three distinct lifecycle classes
// behind one "provisioning" label. `AllocatorTaxonomy` names them explicitly
// (`provisioning` / `fixed_pool` / `delegated` / `routed`) so consumers that
// need to reason about "does release destroy?" can branch on a typed capability
// instead of an ad-hoc kind allowlist. This file pins the invariants that make
// the taxonomy trustworthy:
//
//  1. Every `AllocatorKind` has a stable KIND-level taxonomy
//     (`allocatorTaxonomyFor`) that matches the INSTANCE-level `taxonomy` field
//     each real allocator class declares. A drift here would defeat the whole
//     point of the reclassification.
//  2. The `AllocatorRouter` reports `"routed"` — it does not itself provision,
//     lease, or delegate.
//  3. `UnconfiguredAllocator` (the placeholder stub) forwards the taxonomy
//     that the KIND it stands in for would declare — so an operator inspecting
//     the registry reads the correct lifecycle class even when the credentials
//     are unloaded.
//  4. `FakeAllocator` reports `"fixed_pool"` — its `release()` is a no-op, so
//     lease semantics is the honest class.
//  5. Fixed-pool allocators' release is a LEASE-FREE (never a destroy of a
//     nonexistent cloud resource) — the taxonomy is not just a documentation
//     value; it corresponds to observable behavior.

import { describe, expect, it } from "vitest";
// The allocators barrel re-exports the seam types + non-cloud impls; the cloud
// allocators aren't in it, so each cloud kind is a direct per-file import (the
// contracts + secretStore ride through `contracts/index.js` to keep the total
// import-dependency count under the lint cap).
import {
  AllocatorKind,
  AllocatorRoutingConfig,
  AllocatorRouter,
  allocatorTaxonomyFor,
  HetznerAllocator,
  ManualSshAllocator,
  SidecarHttpAllocator,
  StaticRunnerAllocator,
  UnconfiguredAllocator,
  type AllocatorRegistry,
  type ClaimRunnerInput,
  type ProviderTeardownMetadata,
  type RunnerStore,
} from "../src/engine/allocators/index.js";
import { AwsEc2Allocator } from "../src/engine/allocators/awsEc2Allocator.js";
import { DigitalOceanAllocator } from "../src/engine/allocators/digitalOceanAllocator.js";
import { GcpAllocator } from "../src/engine/allocators/gcpAllocator.js";
import { KubernetesAllocator } from "../src/engine/allocators/kubernetesAllocator.js";
import {
  FakeAllocator,
  InMemorySecretStore,
  type Allocator,
  type AllocatorTaxonomy,
} from "../src/engine/contracts/index.js";
import { generateEd25519KeyPair } from "../src/engine/ssh/keygen.js";

const PINNED_FINGERPRINT = "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class MemoryRunnerStore implements RunnerStore {
  private readonly claimed = new Map<string, ClaimRunnerInput>();
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claimed.set(input.runnerId, input);
  }
  async release(runnerId: string): Promise<void> {
    this.claimed.delete(runnerId);
  }
  async readTeardownDescriptor(runnerId: string): Promise<ProviderTeardownMetadata | undefined> {
    return this.claimed.get(runnerId)?.providerMetadata ?? undefined;
  }
  size(): number {
    return this.claimed.size;
  }
}

// The instance-level taxonomy every real (non-stub, non-router) allocator
// declares — the source of truth the KIND-level `allocatorTaxonomyFor` mapping
// must agree with.
const INSTANCE_TAXONOMY_BY_KIND: Record<Exclude<AllocatorKind, never>, AllocatorTaxonomy> = {
  static: new StaticRunnerAllocator({
    host: "runner",
    port: 22,
    hostKeyFingerprint: PINNED_FINGERPRINT,
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  manual_ssh: new ManualSshAllocator({
    hosts: [{ id: "h1", host: "10.0.0.1", hostKeyFingerprint: PINNED_FINGERPRINT }],
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  sidecar: new SidecarHttpAllocator({
    baseUrl: "http://allocator:3200",
    authToken: "t",
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  hetzner: new HetznerAllocator({
    apiToken: "t",
    serverType: "cx22",
    image: "docker-ce",
    runners: new MemoryRunnerStore(),
    secrets: new InMemorySecretStore(),
    generateKeyPair: () => generateEd25519KeyPair(),
  }).taxonomy,
  digitalocean: new DigitalOceanAllocator({
    apiToken: "t",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    region: "nyc3",
    size: "s-1vcpu-1gb",
    image: "docker-20-04",
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  gcp: new GcpAllocator({
    accessToken: "t",
    project: "p",
    zone: "us-central1-a",
    machineType: "e2-small",
    sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
    sshUsername: "tanren",
    sshPublicKey: "ssh-ed25519 AAAA",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  aws_ec2: new AwsEc2Allocator({
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    region: "us-east-1",
    imageId: "ami-0abcd1234",
    instanceType: "t3.small",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    sshUsername: "ec2-user",
    runners: new MemoryRunnerStore(),
  }).taxonomy,
  kubernetes: new KubernetesAllocator({
    apiServer: "https://10.0.0.1:6443",
    token: "t",
    namespace: "tanren",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    sshPublicKey: "ssh-ed25519 AAAA",
    hostKeyFingerprint: PINNED_FINGERPRINT,
    sshUsername: "tanren",
    runners: new MemoryRunnerStore(),
  }).taxonomy,
};

describe("AllocatorTaxonomy — reclassification invariants (Codex H3 #14/#15/#16)", () => {
  describe("KIND-level `allocatorTaxonomyFor` matches INSTANCE-level `taxonomy`", () => {
    // Guarantee: the two lookups can never drift. If a new kind lands or an
    // existing allocator's class changes, this test forces the mapping and
    // the class to be updated together.
    for (const kind of AllocatorKind.options) {
      it(`${kind} → same taxonomy from both lookups`, () => {
        expect(allocatorTaxonomyFor(kind)).toBe(INSTANCE_TAXONOMY_BY_KIND[kind]);
      });
    }
  });

  describe("KIND catalog is partitioned into the three concerns", () => {
    // The doctrinal partitioning from Codex H3 #14/#15/#16:
    //  - fixed_pool: static + manual_ssh (lease + release, no destroy)
    //  - delegated:  sidecar (HTTP-delegates provisioning to a sidecar)
    //  - provisioning: every real cloud kind (allocate creates + release destroys)
    it("static + manual_ssh are fixed_pool", () => {
      expect(allocatorTaxonomyFor("static")).toBe("fixed_pool");
      expect(allocatorTaxonomyFor("manual_ssh")).toBe("fixed_pool");
    });
    it("sidecar is delegated", () => {
      expect(allocatorTaxonomyFor("sidecar")).toBe("delegated");
    });
    it("every cloud kind is provisioning", () => {
      for (const cloud of ["hetzner", "digitalocean", "gcp", "aws_ec2", "kubernetes"] as const) {
        expect(allocatorTaxonomyFor(cloud)).toBe("provisioning");
      }
    });
  });

  describe("Router + UnconfiguredAllocator + Fake report the honest class", () => {
    it("AllocatorRouter reports `routed`", () => {
      const registry: AllocatorRegistry = Object.fromEntries(
        AllocatorKind.options.map((k): [AllocatorKind, Allocator] => [k, new UnconfiguredAllocator(k)]),
      ) as AllocatorRegistry;
      const config = AllocatorRoutingConfig.parse({ defaultAllocator: "static", rules: [] });
      expect(new AllocatorRouter(registry, config).taxonomy).toBe("routed");
    });

    it("UnconfiguredAllocator forwards the taxonomy of the KIND it stands in for", () => {
      for (const kind of AllocatorKind.options) {
        expect(new UnconfiguredAllocator(kind).taxonomy).toBe(allocatorTaxonomyFor(kind));
      }
    });

    it("FakeAllocator reports `fixed_pool` (its release is a no-op — lease semantics)", () => {
      expect(new FakeAllocator().taxonomy).toBe("fixed_pool");
    });
  });

  describe("Fixed-pool release semantics — the taxonomy is not just documentation", () => {
    // A fixed-pool allocator's `release()` MUST NOT try to destroy a cloud
    // resource — it only frees the lease + clears the mirror row. If a
    // fixed-pool impl attempted a destroy call, the taxonomy would be
    // misclassifying itself.
    //
    // The invariant here is negative — proving a destroy DID NOT happen — so we
    // exercise the impls with a scaffold that would throw on any destroy call
    // (a MemoryRunnerStore only knows `claim` + `release`, not any
    // provisioner call). Release must complete cleanly.
    it("StaticRunnerAllocator.release() clears the mirror row only", async () => {
      const store = new MemoryRunnerStore();
      const allocator = new StaticRunnerAllocator({
        host: "runner",
        port: 22,
        hostKeyFingerprint: PINNED_FINGERPRINT,
        runners: store,
      });
      const allocation = await allocator.allocate({
        runId: "run_fp_1",
        projectId: "proj_1",
        runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
        identitySecretRef: "runner/identity",
      });
      expect(store.size()).toBe(1);
      await expect(allocator.release(allocation.runnerId, "completed")).resolves.toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("ManualSshAllocator.release() frees the lease + clears the mirror row only", async () => {
      const store = new MemoryRunnerStore();
      const allocator = new ManualSshAllocator({
        hosts: [{ id: "h1", host: "10.0.0.1", hostKeyFingerprint: PINNED_FINGERPRINT }],
        runners: store,
      });
      const allocation = await allocator.allocate({
        runId: "run_fp_2",
        projectId: "proj_1",
        runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
        identitySecretRef: "runner/identity",
      });
      expect(store.size()).toBe(1);
      // A second allocate would fail on an exhausted single-host pool — this is
      // the fixed-pool "lease" shape; a cloud allocator would just provision a
      // new resource.
      await expect(
        allocator.allocate({
          runId: "run_fp_2b",
          projectId: "proj_1",
          runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
          identitySecretRef: "runner/identity",
        }),
      ).rejects.toThrow(/exhausted/u);
      await expect(allocator.release(allocation.runnerId, "completed")).resolves.toBeUndefined();
      expect(store.size()).toBe(0);
    });
  });
});
