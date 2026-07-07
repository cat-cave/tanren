// Task #31: per-allocator readiness convergence conformance for GCP.
//
// Pins the 4-scenario contract at the GCP-specific wiring. The advancing harness
// threads CHANGING instance statuses across probes (PROVISIONING → STAGING →
// RUNNING|no-ip → RUNNING|ip). The stuck harness pins `PROVISIONING|no-ip`. Split
// from `gcpAllocator.test.ts` to keep each test file under the line cap.

import { describe, expect, it } from "vitest";
import {
  GcpAllocator,
  GcpAllocatorError,
  type GcpComputeClient,
  type GcpInstance,
  type GcpOperation,
} from "../src/engine/allocators/gcpAllocator.js";
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
  // Codex H3 #13 fallback: metadata captured at claim time, sans released.
  async readTeardownDescriptor(runnerId: string) {
    if (this.releases.includes(runnerId)) return;
    return this.claims.find((c) => c.runnerId === runnerId)?.providerMetadata ?? undefined;
  }
}

class ScenarioFakeGcpComputeClient implements GcpComputeClient {
  private getCalls = 0;
  constructor(
    private readonly opts: {
      stuck?: boolean;
      unknownStatus?: string;
      terminalStatus?: string;
    } = {},
  ) {}
  async insertInstance(): Promise<GcpOperation> {
    return { name: "op-adv", status: "DONE" };
  }
  async getZoneOperation(): Promise<GcpOperation> {
    return { name: "op-adv", status: "DONE" };
  }
  async getInstance(instanceName: string): Promise<GcpInstance> {
    this.getCalls += 1;
    if (this.opts.terminalStatus !== undefined) {
      return { name: instanceName, status: this.opts.terminalStatus };
    }
    if (this.opts.unknownStatus !== undefined) {
      return { name: instanceName, status: this.opts.unknownStatus };
    }
    if (this.opts.stuck === true) {
      return { name: instanceName, status: "PROVISIONING" };
    }
    if (this.getCalls >= 8) {
      return { name: instanceName, status: "RUNNING", externalIp: "203.0.113.50" };
    }
    const status = this.getCalls < 3 ? "PROVISIONING" : this.getCalls < 5 ? "STAGING" : "RUNNING";
    const externalIp = this.getCalls % 2 === 0 ? undefined : `intermediate-${this.getCalls}`;
    return { name: instanceName, status, externalIp };
  }
  async deleteInstance(): Promise<void> {}
}

function baseOpts(client: GcpComputeClient, runners: RunnerStore) {
  return {
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
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => undefined,
  };
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_gcp",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const harness = {
  buildAdvancing() {
    const client = new ScenarioFakeGcpComputeClient();
    const runners = new FakeRunnerStore();
    return {
      allocator: new GcpAllocator(baseOpts(client, runners)),
      request: req("run_adv"),
      expectedAdvancingProbes: 7,
    };
  },
  buildStuck() {
    const client = new ScenarioFakeGcpComputeClient({ stuck: true });
    const runners = new FakeRunnerStore();
    return {
      allocator: new GcpAllocator(baseOpts(client, runners)),
      request: req("run_stuck"),
      expectedStuckSignature: "PROVISIONING|no-ip",
    };
  },
  buildUnknownState() {
    const client = new ScenarioFakeGcpComputeClient({ unknownStatus: "RECONCILING-NEW-FEATURE" });
    const runners = new FakeRunnerStore();
    return {
      allocator: new GcpAllocator(baseOpts(client, runners)),
      request: req("run_unk"),
      expectedUnknownState: "RECONCILING-NEW-FEATURE",
    };
  },
  buildTerminalArm(terminalState: string) {
    const client = new ScenarioFakeGcpComputeClient({ terminalStatus: terminalState });
    const runners = new FakeRunnerStore();
    return {
      allocator: new GcpAllocator(baseOpts(client, runners)),
      request: req("run_term"),
    };
  },
  // GCP `GCP_INSTANCE_TERMINAL_STATUSES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["STOPPING", "STOPPED", "SUSPENDING", "SUSPENDED", "TERMINATED"] as const,
};

describe("GcpAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as GcpAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildTerminalArm("TERMINATED");
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(GcpAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

describeReadinessConvergence("Gcp", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, GcpAllocatorError) };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, GcpAllocatorError) };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, GcpAllocatorError) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, GcpAllocatorError) };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});
