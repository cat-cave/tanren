// Seam conformance suite for the Allocator contract
// (`engine/contracts/allocator.ts`). This is a reusable behavior spec invoked
// once per implementation via `describeAllocatorConformance`. It asserts the
// CONTRACT only — the shape of `RunnerAllocation`, release idempotency, and
// (optionally) that provisioning failures surface as the seam's typed error —
// never private fields or mock-call counts. The same fixtures validate the
// fake, the static/manual allocators, and every cloud allocator driven by its
// injected mock client. Track C §2 of docs/architecture/portability-and-longevity.md.
import { describe, expect, it } from "vitest";
import type { AllocationRequest, Allocator } from "../../src/engine/contracts/allocator.js";

/**
 * What a per-implementation test file hands the suite. `make()` must return a
 * FRESH allocator wired to its own scaffolding (mock client / runner-store)
 * so each spec runs in isolation. `request()` returns a valid allocation
 * request for the given run id.
 */
export interface AllocatorConformanceHarness {
  /** Build a fresh allocator under test. */
  make(): Allocator;
  /** A well-formed allocation request for `runId`. */
  request(runId: string): AllocationRequest;
}

/**
 * Optional failure-mode harness. Impls with an injectable failure path
 * (e.g. a cloud allocator whose provisioning never completes, or an exhausted
 * manual pool) pass this to `describeAllocatorFailureConformance` to assert
 * that the failure surfaces as a rejected promise (the seam's typed error).
 * Impls with no failure mode (the fake/static) simply don't call it.
 */
export interface AllocatorFailureHarness {
  /** Build an allocator + request whose `allocate()` is forced to reject. */
  makeFailing(): { allocator: Allocator; request: AllocationRequest };
}

const SHA256_FINGERPRINT = /^SHA256:.+/;

function expectWellFormedAllocation(
  allocation: Awaited<ReturnType<Allocator["allocate"]>>,
  identitySecretRef: string
): void {
  // runnerId: non-empty stable handle the orchestrator releases later.
  expect(typeof allocation.runnerId).toBe("string");
  expect(allocation.runnerId.length).toBeGreaterThan(0);

  // imageSha: a pinned, content-addressed image reference.
  expect(typeof allocation.imageSha).toBe("string");
  expect(allocation.imageSha.length).toBeGreaterThan(0);

  // target: a complete, connectable SshTarget.
  const target = allocation.target;
  expect(typeof target.host).toBe("string");
  expect(target.host.length).toBeGreaterThan(0);
  expect(typeof target.port).toBe("number");
  expect(target.port).toBeGreaterThan(0);
  expect(typeof target.username).toBe("string");
  expect(target.username.length).toBeGreaterThan(0);
  // Fingerprint must be a verifiable SHA256 host key (no blind TOFU surfaced).
  expect(target.hostKeyFingerprint).toMatch(SHA256_FINGERPRINT);
  // The identity ref is a Vault reference, never an inlined key. The contract
  // does not mandate it equal the request's ref (manual hosts may pin their
  // own), only that it be a non-empty ref.
  expect(typeof target.identitySecretRef).toBe("string");
  expect(target.identitySecretRef.length).toBeGreaterThan(0);
  // Identity ref shape sanity: must not be the literal private key material.
  expect(target.identitySecretRef).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  void identitySecretRef;
}

/**
 * Behavior spec every Allocator implementation must pass. Call once per impl:
 *
 *   describeAllocatorConformance("HetznerAllocator", {
 *     make: () => new HetznerAllocator(opts(mockClient())),
 *     request: (runId) => ({ runId, projectId, runnerImage, identitySecretRef }),
 *     makeFailing: () => ({ allocator: ..., request: ... })
 *   });
 */
export function describeAllocatorConformance(label: string, harness: AllocatorConformanceHarness): void {
  describe(`Allocator conformance: ${label}`, () => {
    it("allocate() returns a well-formed RunnerAllocation", async () => {
      const allocator = harness.make();
      const request = harness.request("conf_alloc_1");
      const allocation = await allocator.allocate(request);
      expectWellFormedAllocation(allocation, request.identitySecretRef);
    });

    it("release() of a freshly allocated runner resolves", async () => {
      const allocator = harness.make();
      const allocation = await allocator.allocate(harness.request("conf_alloc_2"));
      await expect(allocator.release(allocation.runnerId, "completed")).resolves.toBeUndefined();
    });

    it("release() is idempotent — double-release is a no-op", async () => {
      const allocator = harness.make();
      const allocation = await allocator.allocate(harness.request("conf_alloc_3"));
      await allocator.release(allocation.runnerId, "completed");
      // The second release must not throw and must not re-destroy.
      await expect(allocator.release(allocation.runnerId, "completed")).resolves.toBeUndefined();
    });

    it("release() of an unknown runner id is a no-op", async () => {
      const allocator = harness.make();
      await expect(allocator.release("runner_does_not_exist", "abandoned")).resolves.toBeUndefined();
    });

    it("release() defaults the reason and still resolves", async () => {
      const allocator = harness.make();
      const allocation = await allocator.allocate(harness.request("conf_alloc_4"));
      await expect(allocator.release(allocation.runnerId)).resolves.toBeUndefined();
    });

  });
}

/**
 * Failure-mode spec for allocators that expose an injectable failure path.
 * Call once per such impl, alongside `describeAllocatorConformance`:
 *
 *   describeAllocatorFailureConformance("HetznerAllocator", {
 *     makeFailing: () => ({ allocator, request })
 *   });
 */
export function describeAllocatorFailureConformance(label: string, harness: AllocatorFailureHarness): void {
  describe(`Allocator failure conformance: ${label}`, () => {
    it("surfaces provisioning failure as a rejected promise (typed error)", async () => {
      const { allocator, request } = harness.makeFailing();
      await expect(allocator.allocate(request)).rejects.toThrow(Error);
    });
  });
}
