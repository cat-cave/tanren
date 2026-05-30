import { describe, expect, it } from "vitest";
import { AllocatorRouter, type AllocatorRegistry } from "../src/engine/allocators/allocatorRouter.js";
import {
  AllocatorKind,
  AllocatorRoutingConfig,
  PoolCapacityExceededError,
  PoolPolicy,
  selectAllocatorKind,
} from "../src/engine/allocators/poolPolicy.js";
import { UnconfiguredAllocator } from "../src/engine/allocators/scaffoldedAllocators.js";
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
      target: {
        host: this.name,
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:x",
        identitySecretRef: "r",
      },
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
    gcp: new RecordingAllocator("gcp"),
    aws_ec2: new RecordingAllocator("aws_ec2"),
    kubernetes: new RecordingAllocator("kubernetes"),
  };
  const reg: AllocatorRegistry = {
    static: recorders.static,
    sidecar: recorders.sidecar,
    manual_ssh: recorders.manual_ssh,
    hetzner: recorders.hetzner,
    digitalocean: recorders.digitalocean,
    gcp: recorders.gcp,
    aws_ec2: recorders.aws_ec2,
    kubernetes: recorders.kubernetes,
    ...overrides,
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
      { matchLabels: { env: "staging", tier: "cpu" }, allocator: "manual_ssh" },
    ],
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
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }],
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
      rules: [{ matchLabels: { cloud: "do" }, allocator: "digitalocean" }],
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
      rules: [{ matchLabels: { cloud: "gcp" }, allocator: "gcp" }],
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_gcp", { cloud: "gcp" }));

    expect(recorders.gcp.allocated.map((r) => r.runId)).toEqual(["run_gcp"]);
    expect(recorders.sidecar.allocated).toEqual([]);
  });

  it("routes by label/config to the aws_ec2 allocator", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { cloud: "aws" }, allocator: "aws_ec2" }],
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_aws", { cloud: "aws" }));

    expect(recorders.aws_ec2.allocated.map((r) => r.runId)).toEqual(["run_aws"]);
    expect(recorders.sidecar.allocated).toEqual([]);
  });

  it("routes by label/config to the kubernetes allocator", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { cloud: "k8s" }, allocator: "kubernetes" }],
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);

    await router.allocate(req("run_k8s", { cloud: "k8s" }));

    expect(recorders.kubernetes.allocated.map((r) => r.runId)).toEqual(["run_k8s"]);
    expect(recorders.sidecar.allocated).toEqual([]);
  });

  it("release routes back to the allocator that served the runner", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }],
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
      pools: { manual_ssh: { maxConcurrent: 2 } },
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
      pools: { manual_ssh: { maxConcurrent: 1 } },
    });
    const failing = new RecordingAllocator("manual_ssh");
    failing.allocate = async () => {
      throw new Error("boom");
    };
    const { reg } = registry({ manual_ssh: failing });
    const router = new AllocatorRouter(reg, config);

    await expect(router.allocate(req("run_1"))).rejects.toThrow(/boom/u);
    expect(router.inFlightCount("manual_ssh")).toBe(0);
  });

  it("routing to an unconfigured kind throws the clear not-configured error", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "kubernetes",
    });
    // Registry where kubernetes was never wired with credentials.
    const { reg } = registry({ kubernetes: new UnconfiguredAllocator("kubernetes") });
    const router = new AllocatorRouter(reg, config);
    await expect(router.allocate(req("run_k8s"))).rejects.toThrow(/not configured/u);
    // And the failed allocation did not leak a slot.
    expect(router.inFlightCount("kubernetes")).toBe(0);
  });

  it("release of a runner unknown to this router instance is a safe no-op", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }],
    });
    const { reg, recorders } = registry();
    const router = new AllocatorRouter(reg, config);
    // Never allocated through this router, so runnerKinds has no entry. The
    // `kind === undefined` guard must short-circuit to a no-op rather than
    // dispatching to a backing allocator or touching the in-flight counters.
    await router.release("runner_never_seen", "completed");
    for (const recorder of Object.values(recorders)) {
      expect(recorder.released).toEqual([]);
    }
    expect(router.inFlightCount("sidecar")).toBe(0);
    expect(router.inFlightCount("hetzner")).toBe(0);
  });
});

describe("UnconfiguredAllocator", () => {
  it("throws a clear not-configured error on allocate and release", async () => {
    const allocator = new UnconfiguredAllocator("kubernetes");
    await expect(allocator.allocate(req("r"))).rejects.toThrow(/not configured/u);
    await expect(allocator.release("r")).rejects.toThrow(/not configured/u);
  });

  it("names the offending kind and the remediation env in its error", async () => {
    const allocator = new UnconfiguredAllocator("gcp");
    // The two string fragments are distinct mutation survivors; pin both the
    // kind interpolation and the "no routing rule references it" explanation so
    // a blanked-out message string is caught.
    await expect(allocator.allocate(req("r"))).rejects.toThrow(/allocator kind 'gcp' was selected/u);
    await expect(allocator.allocate(req("r"))).rejects.toThrow(/no routing rule references it/u);
    await expect(allocator.allocate(req("r"))).rejects.toThrow(/TANREN_ALLOCATOR_ROUTING/u);
  });
});

describe("AllocatorKind enum", () => {
  it("accepts exactly the eight supported kinds", () => {
    expect(new Set(AllocatorKind.options)).toEqual(
      new Set(["static", "sidecar", "manual_ssh", "hetzner", "digitalocean", "gcp", "aws_ec2", "kubernetes"]),
    );
  });

  it("rejects an unknown kind", () => {
    expect(AllocatorKind.safeParse("fly_io").success).toBe(false);
  });

  it("accepts manual_ssh as a parseable kind", () => {
    // Pins the exact `manual_ssh` enum member: a mutant that blanks that string
    // literal would make this exact value unparseable.
    expect(AllocatorKind.parse("manual_ssh")).toBe("manual_ssh");
    expect(AllocatorKind.safeParse("manual_ssh").success).toBe(true);
  });
});

describe("PoolPolicy schema defaults", () => {
  it("defaults reuse to false (ephemeral) when omitted", () => {
    expect(PoolPolicy.parse({}).reuse).toBe(false);
  });

  it("preserves an explicit reuse=true", () => {
    expect(PoolPolicy.parse({ reuse: true }).reuse).toBe(true);
  });

  it("rejects maxConcurrent below 1", () => {
    expect(PoolPolicy.safeParse({ maxConcurrent: 0 }).success).toBe(false);
  });
});

describe("AllocatorRoutingConfig schema defaults", () => {
  it("defaults rules to an empty array and pools to an empty record", () => {
    const config = AllocatorRoutingConfig.parse({ defaultAllocator: "sidecar" });
    expect(config.rules).toEqual([]);
    expect(config.pools).toEqual({});
  });
});

describe("PoolCapacityExceededError", () => {
  it("carries the kind + cap and a message naming both", () => {
    const error = new PoolCapacityExceededError("hetzner", 3);
    expect(error.kind).toBe("hetzner");
    expect(error.maxConcurrent).toBe(3);
    expect(error.name).toBe("PoolCapacityExceededError");
    expect(error.message).toContain("hetzner");
    expect(error.message).toContain("3");
    expect(error.message).toMatch(/at capacity/u);
  });
});
