// Mutation-strength pins for engine/allocators/** (issue #838 / CX-046).
//
// Targets survivors the baseline called out (router, poolPolicy, scaffolded
// stubs, parseSshPort) plus the #1254 enforcesOwnPoolCap skip path that the
// router's in-memory counter must NOT double-book.

import { describe, expect, it } from "vitest";
import { AllocatorRouter, type AllocatorRegistry } from "../src/engine/allocators/allocatorRouter.js";
import { parseSshPort } from "../src/engine/allocators/buildAllocator.js";
import {
  AllocatorKind,
  AllocatorRoutingConfig,
  LabelRoutingRule,
  PoolCapacityExceededError,
  PoolPolicy,
  allocatorTaxonomyFor,
  selectAllocatorKind,
} from "../src/engine/allocators/poolPolicy.js";
import { UnconfiguredAllocator } from "../src/engine/allocators/scaffoldedAllocators.js";
import type { AllocationRequest, Allocator, RunnerAllocation } from "../src/engine/contracts/allocator.js";

class RecordingAllocator implements Allocator {
  readonly taxonomy = "fixed_pool" as const;
  readonly allocated: AllocationRequest[] = [];
  readonly released: Array<{ runnerId: string; reason?: string }> = [];
  enforcesOwnPoolCap?: boolean;
  failAllocate = false;

  constructor(
    private readonly name: string,
    options?: { enforcesOwnPoolCap?: boolean },
  ) {
    if (options?.enforcesOwnPoolCap === true) {
      this.enforcesOwnPoolCap = true;
    }
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    if (this.failAllocate) {
      throw new Error(`${this.name}-boom`);
    }
    this.allocated.push(request);
    return {
      runnerId: `runner_${this.name}_${request.runId}`,
      imageSha: "sha256:x",
      target: {
        backend: "ssh",
        host: this.name,
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:x",
        identitySecretRef: "r",
      },
    };
  }

  async release(runnerId: string, reason?: string): Promise<void> {
    this.released.push({ runnerId, reason });
  }
}

function fullRegistry(overrides: Partial<AllocatorRegistry> = {}): {
  reg: AllocatorRegistry;
  recorders: Record<AllocatorKind, RecordingAllocator>;
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
  const reg: AllocatorRegistry = { ...recorders, ...overrides };
  return { reg, recorders };
}

function req(runId: string, labels?: Record<string, string>): AllocationRequest {
  return { runId, projectId: "p", runnerImage: "img", identitySecretRef: "r", labels };
}

describe("selectAllocatorKind — label match edge cases", () => {
  it("empty matchLabels matches any run (vacuous AND)", () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      rules: [{ matchLabels: {}, allocator: "hetzner" }],
    });
    expect(selectAllocatorKind(config, {})).toBe("hetzner");
    expect(selectAllocatorKind(config, { tier: "gpu" })).toBe("hetzner");
  });

  it("requires exact value equality (not just key presence)", () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "static",
      rules: [{ matchLabels: { tier: "gpu" }, allocator: "hetzner" }],
    });
    expect(selectAllocatorKind(config, { tier: "cpu" })).toBe("static");
    expect(selectAllocatorKind(config, { tier: "gpu" })).toBe("hetzner");
  });

  it("first matching rule wins; later rules are not consulted", () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "static",
      rules: [
        { matchLabels: { env: "prod" }, allocator: "hetzner" },
        { matchLabels: { env: "prod" }, allocator: "gcp" },
      ],
    });
    expect(selectAllocatorKind(config, { env: "prod" })).toBe("hetzner");
  });
});

describe("AllocatorRouter — capacity + enforcesOwnPoolCap", () => {
  it("skips the in-memory maxConcurrent counter when the backing allocator enforces its own cap", async () => {
    // #1254: manual_ssh (and any enforcesOwnPoolCap=true) is the sole cap authority
    // via the shared store. The router's per-process counter must not refuse.
    const selfCapped = new RecordingAllocator("manual_ssh", { enforcesOwnPoolCap: true });
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "manual_ssh",
      pools: { manual_ssh: { maxConcurrent: 1 } },
    });
    const { reg } = fullRegistry({ manual_ssh: selfCapped });
    const router = new AllocatorRouter(reg, config);

    const a = await router.allocate(req("run_1"));
    const b = await router.allocate(req("run_2"));
    // Would throw PoolCapacityExceededError if the router counter still ran.
    expect(a.runnerId).toBe("runner_manual_ssh_run_1");
    expect(b.runnerId).toBe("runner_manual_ssh_run_2");
    expect(router.inFlightCount("manual_ssh")).toBe(0);
    expect(selfCapped.allocated).toHaveLength(2);

    await router.release(a.runnerId, "completed");
    await router.release(b.runnerId, "completed");
    // Release must also skip the counter (no underflow into negative via Math.max).
    expect(router.inFlightCount("manual_ssh")).toBe(0);
    expect(selfCapped.released.map((r) => r.runnerId)).toEqual([a.runnerId, b.runnerId]);
  });

  it("still enforces maxConcurrent for kinds that do NOT set enforcesOwnPoolCap", async () => {
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "hetzner",
      pools: { hetzner: { maxConcurrent: 1 } },
    });
    const { reg, recorders } = fullRegistry();
    const router = new AllocatorRouter(reg, config);

    const a = await router.allocate(req("run_1"));
    expect(router.inFlightCount("hetzner")).toBe(1);
    await expect(router.allocate(req("run_2"))).rejects.toBeInstanceOf(PoolCapacityExceededError);
    await expect(router.allocate(req("run_2"))).rejects.toMatchObject({ kind: "hetzner", maxConcurrent: 1 });

    await router.release(a.runnerId);
    expect(router.inFlightCount("hetzner")).toBe(0);
    await expect(router.allocate(req("run_3"))).resolves.toBeDefined();
    expect(recorders.hetzner.allocated.map((r) => r.runId)).toEqual(["run_1", "run_3"]);
  });

  it("unbounded pools (no maxConcurrent) never throw capacity errors", async () => {
    // reuse metadata only — no cap
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "sidecar",
      pools: { sidecar: { reuse: true } },
    });
    const { reg } = fullRegistry();
    const router = new AllocatorRouter(reg, config);
    await router.allocate(req("a"));
    await router.allocate(req("b"));
    await router.allocate(req("c"));
    expect(router.inFlightCount("sidecar")).toBe(3);
  });

  it("releases capacity when allocate throws, even at the cap boundary", async () => {
    const failing = new RecordingAllocator("gcp");
    failing.failAllocate = true;
    const config = AllocatorRoutingConfig.parse({
      defaultAllocator: "gcp",
      pools: { gcp: { maxConcurrent: 1 } },
    });
    const { reg } = fullRegistry({ gcp: failing });
    const router = new AllocatorRouter(reg, config);

    await expect(router.allocate(req("boom"))).rejects.toThrow(/gcp-boom/u);
    expect(router.inFlightCount("gcp")).toBe(0);
    // Slot is free again for a subsequent success.
    failing.failAllocate = false;
    await expect(router.allocate(req("ok"))).resolves.toMatchObject({ runnerId: "runner_gcp_ok" });
    expect(router.inFlightCount("gcp")).toBe(1);
  });

  it("reports taxonomy 'routed' and release forwards reason to the backing allocator", async () => {
    const config = AllocatorRoutingConfig.parse({ defaultAllocator: "static" });
    const { reg, recorders } = fullRegistry();
    const router = new AllocatorRouter(reg, config);
    expect(router.taxonomy).toBe("routed");
    const allocation = await router.allocate(req("r1"));
    await router.release(allocation.runnerId, "failed");
    expect(recorders.static.released).toEqual([{ runnerId: allocation.runnerId, reason: "failed" }]);
  });
});

describe("poolPolicy schemas + taxonomy", () => {
  it("AllocatorKind is closed over exactly eight kinds", () => {
    expect(AllocatorKind.options).toEqual([
      "static",
      "sidecar",
      "manual_ssh",
      "hetzner",
      "digitalocean",
      "gcp",
      "aws_ec2",
      "kubernetes",
    ]);
    expect(AllocatorKind.safeParse("local_docker").success).toBe(false);
  });

  it("allocatorTaxonomyFor classifies every kind (no silent default)", () => {
    expect(allocatorTaxonomyFor("static")).toBe("fixed_pool");
    expect(allocatorTaxonomyFor("manual_ssh")).toBe("fixed_pool");
    expect(allocatorTaxonomyFor("sidecar")).toBe("delegated");
    for (const kind of ["hetzner", "digitalocean", "gcp", "aws_ec2", "kubernetes"] as const) {
      expect(allocatorTaxonomyFor(kind)).toBe("provisioning");
    }
  });

  it("PoolPolicy rejects non-integer / non-positive maxConcurrent and unknown keys", () => {
    expect(PoolPolicy.safeParse({ maxConcurrent: 1 }).success).toBe(true);
    expect(PoolPolicy.safeParse({ maxConcurrent: 1.5 }).success).toBe(false);
    expect(PoolPolicy.safeParse({ maxConcurrent: -1 }).success).toBe(false);
    expect(PoolPolicy.safeParse({ maxConcurrent: 0 }).success).toBe(false);
    expect(PoolPolicy.safeParse({ unknown: true }).success).toBe(false);
    expect(PoolPolicy.parse({}).reuse).toBe(false);
  });

  it("LabelRoutingRule + AllocatorRoutingConfig are strict and default rules/pools", () => {
    expect(LabelRoutingRule.safeParse({ matchLabels: { a: "b" }, allocator: "static" }).success).toBe(true);
    expect(LabelRoutingRule.safeParse({ matchLabels: { a: 1 }, allocator: "static" }).success).toBe(false);
    expect(LabelRoutingRule.safeParse({ matchLabels: {}, allocator: "fly" }).success).toBe(false);
    const config = AllocatorRoutingConfig.parse({ defaultAllocator: "kubernetes" });
    expect(config.rules).toEqual([]);
    expect(config.pools).toEqual({});
    expect(AllocatorRoutingConfig.safeParse({ defaultAllocator: "nope" }).success).toBe(false);
  });

  it("PoolCapacityExceededError message embeds kind and cap", () => {
    const err = new PoolCapacityExceededError("aws_ec2", 7);
    expect(err.name).toBe("PoolCapacityExceededError");
    expect(err.kind).toBe("aws_ec2");
    expect(err.maxConcurrent).toBe(7);
    expect(err.message).toBe("allocator pool 'aws_ec2' at capacity: 7 concurrent runner(s) in flight");
  });
});

describe("UnconfiguredAllocator + parseSshPort", () => {
  it("forwards taxonomy for known kinds and degrades unknown to provisioning", () => {
    expect(new UnconfiguredAllocator("manual_ssh").taxonomy).toBe("fixed_pool");
    expect(new UnconfiguredAllocator("sidecar").taxonomy).toBe("delegated");
    expect(new UnconfiguredAllocator("hetzner").taxonomy).toBe("provisioning");
    expect(new UnconfiguredAllocator("not-a-kind").taxonomy).toBe("provisioning");
  });

  it("allocate and release both throw the not-configured remediation message", async () => {
    const allocator = new UnconfiguredAllocator("digitalocean");
    await expect(allocator.allocate(req("r"))).rejects.toThrow(
      /allocator kind 'digitalocean' was selected but is not configured/u,
    );
    await expect(allocator.release("runner_x", "completed")).rejects.toThrow(/TANREN_ALLOCATOR_ROUTING/u);
  });

  it("parseSshPort defaults when unset, accepts valid ports, fails loud on bad values", () => {
    const key = "TANREN_MUTATION_TEST_SSH_PORT";
    const previous = process.env[key];
    try {
      delete process.env[key];
      expect(parseSshPort(key, 22)).toBe(22);
      process.env[key] = "2222";
      expect(parseSshPort(key, 22)).toBe(2222);
      process.env[key] = "1";
      expect(parseSshPort(key, 22)).toBe(1);
      process.env[key] = "65535";
      expect(parseSshPort(key, 22)).toBe(65535);
      // Empty string is treated as unset by env() → default.
      process.env[key] = "";
      expect(parseSshPort(key, 22)).toBe(22);
      for (const bad of ["0", "65536", "22.5", "oops", "-1"]) {
        process.env[key] = bad;
        expect(() => parseSshPort(key, 22)).toThrow(new RegExp(`${key}='${bad}' is not a valid TCP port`, "u"));
      }
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});
