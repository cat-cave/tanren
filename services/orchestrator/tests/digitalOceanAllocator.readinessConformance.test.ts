// Task #31: per-allocator readiness convergence conformance for DigitalOcean.
//
// Pins the 4-scenario contract (advancing-unbounded / stuck-fixed-point /
// unknown-state-fail-closed / terminal-arms) at the DO-specific wiring so a
// future regression on the classifier, signature, or terminal-arm wiring fails
// CI at the SAME contract every other allocator is held to. Split from
// `digitalOceanAllocator.test.ts` to keep each test file under the line cap.

import { describe, expect, it } from "vitest";
import {
  DigitalOceanAllocator,
  DigitalOceanAllocatorError,
  type DigitalOceanClient,
  type DigitalOceanDroplet,
} from "../src/engine/allocators/digitalOceanAllocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
} from "../src/engine/allocators/readinessConvergence.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { describeReadinessConvergence } from "./conformance/readinessConvergenceConformance.js";
import { unwrapCauseAllocator } from "./conformance/readinessConvergenceHelpers.js";

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
 * Configurable fake: drives one scenario per build (stuck / unknown / terminal),
 * or the advancing-signature stream when no opt is set.
 */
class ScenarioFakeDigitalOceanClient implements DigitalOceanClient {
  private getCalls = 0;
  constructor(
    private readonly opts: {
      stuck?: boolean;
      unknownStatus?: string;
      terminalStatus?: string;
    } = {},
  ) {}
  async createDroplet(): Promise<DigitalOceanDroplet> {
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
    if (this.opts.stuck === true) {
      return { id: dropletId, status: "new" };
    }
    // Advancing stream: each probe yields a DIFFERENT structural signature so
    // the convergence detector sees forward motion, ending in ready at probe 8.
    if (this.getCalls >= 8) {
      return { id: dropletId, status: "active", publicIpv4: "203.0.113.20" };
    }
    if (this.getCalls % 2 === 0) {
      return { id: dropletId, status: this.getCalls < 4 ? "new" : "active", publicIpv4: undefined };
    }
    return {
      id: dropletId,
      status: this.getCalls < 4 ? "new" : "active",
      publicIpv4: `intermediate-${this.getCalls}`,
    };
  }
  async deleteDroplet(): Promise<void> {}
}

function baseOpts(client: DigitalOceanClient, runners: RunnerStore) {
  return {
    apiToken: "tok",
    hostKeyFingerprint: "SHA256:digitalocean",
    region: "nyc3",
    size: "s-1vcpu-1gb",
    image: "docker-20-04",
    runners,
    client,
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => undefined,
  };
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_do",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const harness = {
  buildAdvancing() {
    const client = new ScenarioFakeDigitalOceanClient();
    const runners = new FakeRunnerStore();
    return {
      allocator: new DigitalOceanAllocator(baseOpts(client, runners)),
      request: req("run_adv"),
      expectedAdvancingProbes: 7,
    };
  },
  buildStuck() {
    const client = new ScenarioFakeDigitalOceanClient({ stuck: true });
    const runners = new FakeRunnerStore();
    return {
      allocator: new DigitalOceanAllocator(baseOpts(client, runners)),
      request: req("run_stuck"),
      expectedStuckSignature: "new|no-ip",
    };
  },
  buildUnknownState() {
    const client = new ScenarioFakeDigitalOceanClient({ unknownStatus: "rebuilding-from-snapshot-2030" });
    const runners = new FakeRunnerStore();
    return {
      allocator: new DigitalOceanAllocator(baseOpts(client, runners)),
      request: req("run_unk"),
      expectedUnknownState: "rebuilding-from-snapshot-2030",
    };
  },
  buildTerminalArm(terminalState: string) {
    const client = new ScenarioFakeDigitalOceanClient({ terminalStatus: terminalState });
    const runners = new FakeRunnerStore();
    return {
      allocator: new DigitalOceanAllocator(baseOpts(client, runners)),
      request: req("run_term"),
    };
  },
  // DO's documented terminal statuses — the allocator's `DO_TERMINAL_STATUSES`
  // allowlist. `archive` is the only remaining terminal arm — task #42 moved
  // `off` to {@link DO_PROVISIONING_STATUSES} (snapshot-restore intermediate;
  // see that constant's doc). A genuinely stuck `off` droplet still surfaces
  // LOUD via the convergence detector's saturation gate, not via this arm.
  expectedTerminalArms: ["archive"] as const,
};

// The per-allocator wrapper preserves the inner cause for the conformance suite.
describe("DigitalOceanAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as DigitalOceanAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    await expect(allocator.allocate(request)).rejects.toBeInstanceOf(DigitalOceanAllocatorError);
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as DigitalOceanAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as DigitalOceanAllocatorError with cause", async () => {
    // task #42: `archive` is the only remaining DO terminal arm — `off` moved
    // to provisioning (snapshot-restore intermediate; see digitalOceanAllocator.ts).
    const { allocator, request } = harness.buildTerminalArm("archive");
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(DigitalOceanAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

// The shared 4-scenario conformance contract; the unwrap adapter strips the
// typed allocator wrapper so the suite's `instanceof` checks read the inner
// convergence-class errors.
describeReadinessConvergence("DigitalOcean", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, DigitalOceanAllocatorError) };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, DigitalOceanAllocatorError) };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, DigitalOceanAllocatorError) };
  },
  buildTerminalArm: (terminalState: string) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, DigitalOceanAllocatorError) };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});
