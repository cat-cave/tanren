import { describe, expect, it } from "vitest";
import { AllocatorRouter, type AllocatorRegistry } from "../src/engine/allocators/allocatorRouter.js";
import {
  AllocatorRoutingConfig,
  PoolCapacityExceededError,
  selectAllocatorKind
} from "../src/engine/allocators/poolPolicy.js";
import {
  AllocatorNotImplementedError,
  AwsEc2Allocator,
  KubernetesAllocator
} from "../src/engine/allocators/scaffoldedAllocators.js";
import type { AllocationRequest, Allocator, RunnerAllocation } from "../src/engine/contracts/allocator.js";

/** Records which allocator served a request; never actually provisions. */
class RecordingAllocator implements Allocator {
  readonly allocated: AllocationRequest[] = [];
  readonly released: string[] = [];
  constructor(private readonly name: string) {}
  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    this.allocated.push(request);
    return {
      runnerId: `runner_${this.name}_${request.runId}`,
      imageSha: "sha256:x",
      target: { host: this.name, port: 22, username: "tanren", hostKeyFingerprint: "SHA256:x", identitySecretRef: "r" }
    };
  }
  async release(runnerId: string): Promise<void> {
    this.released.push(runnerId);
  }
}

function registry(overrides: Partial<AllocatorRegistry> = {}): {
  reg: AllocatorRegistry;
  recorders: Record<string, RecordingAllocator>;
} {
  const recorders = {
    static: new RecordingAllocator("static"),
    sidecar: new RecordingAllocator("sidecar"),
    manual_ssh: new RecordingAllocator("manual_ssh"),
    hetzner: new RecordingAllocator("hetzner"),
    digitalocean: new RecordingAllocator("digitalocean"),
    gcp: new RecordingAllocator("gcp")
  };
  const reg: AllocatorRegistry = {
    static: recorders.static,
    sidecar: recorders.sidecar,
    manual_ssh: recorders.manual_ssh,
    hetzner: recorders.hetzner,
    digitalocean: recorders.digitalocean,
    gcp: recorders.gcp,
    aws_ec2: new AwsEc2Allocator(),
    kubernetes: new KubernetesAllocator(),
    ...overrides
  };
  return { reg, recorders };
}

function req(runId: string, labels?: Record<string, string>): AllocationRequest {
  return { runId, projectId: "p", runnerImage: "img", identitySecretRef: "r", labels };
}

describe("selectAllocatorKind", () => {
  const config = AllocatorRoutingConfig.parse({
    defaultAllocator: "sidecar",
    rules: [
      { matchLabels: { tier: "gpu" }, allocator: "hetzner" },
      { matchLabels: { env: "staging", tier: "cpu" }, allocator: "manual_ssh" }
    ]
  });

  it("returns the default when no rule matches", () => {
    expect(selectAllocatorKind(config, {})).toBe("sidecar");
    expect(selectAllocatorKind(config, { tier: "cpu" })).toBe("sidecar");
  });

  it("first matching rule wins", () => {
    expect(selectAllocatorKind(config, { tier: "gpu" })).toBe("hetzner");
  });

  it("requires all matchLabels to be present and equal", () => {
    expect(selectAllocatorKind(config, { env: "staging" })).toBe("sidecar");
    expect(selectAllocatorKind(config, { env: "staging", tier: "cpu" })).toBe("manual_ssh");
  });
});

describe("AllocatorRouter", () => {
  it("routes by label to the right backing allocator", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }]
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_default"));
    await router.allocate(req("run_gpu", { tier: "gpu" }));

    expect(recorders.sidecar.allocated.map((r) => r.runId)).toEqual(["run_default"]);
    expect(recorders.hetzner.allocated.map((r) => r.runId)).toEqual(["run_gpu"]);
  });

  it("routes by label/config to the digitalocean allocator", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { cloud: "do" }, allocator: "digitalocean" }]
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_do", { cloud: "do" }));

    expect(recorders.digitalocean.allocated.map((r) => r.runId)).toEqual(["run_do"]);
    expect(recorders.sidecar.allocated).toEqual([]);
  });

  it("routes by label/config to the gcp allocator", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { cloud: "gcp" }, allocator: "gcp" }]
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_gcp", { cloud: "gcp" }));

    expect(recorders.gcp.allocated.map((r) => r.runId)).toEqual(["run_gcp"]);
    expect(recorders.sidecar.allocated).toEqual([]);
  });

  it("release routes back to the allocator that served the runner", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }]
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    const a = await router.allocate(req("run_gpu", { tier: "gpu" }));
    await router.release(a.runnerId, "completed");
    expect(recorders.hetzner.released).toEqual([a.runnerId]);
    expect(recorders.sidecar.released).toEqual([]);
  });

  it("enforces the pool-policy maxConcurrent cap", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "manual_ssh",
      pools: { manual_ssh: { maxConcurrent: 2 } }
    });
    const { reg } = registry();
    const router = new AllocatorRouter(reg, config);

    const a = await router.allocate(req("run_1"));
    await router.allocate(req("run_2"));
    expect(router.inFlightCount("manual_ssh")).toBe(2);

    await expect(router.allocate(req("run_3"))).rejects.toBeInstanceOf(PoolCapacityExceededError);

    // Releasing one frees a slot.
    await router.release(a.runnerId);
    expect(router.inFlightCount("manual_ssh")).toBe(1);
    await expect(router.allocate(req("run_4"))).resolves.toBeDefined();
  });

  it("does not consume a slot when the backing allocator throws", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "manual_ssh",
      pools: { manual_ssh: { maxConcurrent: 1 } }
    });
    const failing = new RecordingAllocator("manual_ssh");
    failing.allocate = async () => {
      throw new Error("boom");
    };
    const { reg } = registry({ manual_ssh: failing });
    const router = new AllocatorRouter(reg, config);

    await expect(router.allocate(req("run_1"))).rejects.toThrow(/boom/);
    expect(router.inFlightCount("manual_ssh")).toBe(0);
  });

  it("routing to a scaffolded kind throws the clear not-implemented error", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "kubernetes"
    });
    const { reg } = registry();
    const router = new AllocatorRouter(reg, config);
    await expect(router.allocate(req("run_k8s"))).rejects.toBeInstanceOf(AllocatorNotImplementedError);
    // And the failed allocation did not leak a slot.
    expect(router.inFlightCount("kubernetes")).toBe(0);
  });
});

describe("scaffolded allocators", () => {
  it("each throws AllocatorNotImplementedError with provider + follow-up hint", async () => {
    for (const allocator of [new AwsEc2Allocator(), new KubernetesAllocator()]) {
      await expect(allocator.allocate(req("r"))).rejects.toBeInstanceOf(AllocatorNotImplementedError);
      await expect(allocator.allocate(req("r"))).rejects.toThrow(/P3-0027 follow-up/);
      await expect(allocator.release("r")).rejects.toBeInstanceOf(AllocatorNotImplementedError);
    }
  });
});
