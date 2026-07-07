// Task #31: per-allocator readiness convergence conformance for AWS EC2.
//
// Pins the 4-scenario contract at the EC2-specific wiring. EC2's documented
// terminal arms (`terminated` / `shutting-down` / `stopping` / `stopped`)
// each fire `ProvisioningTerminalStateError` IMMEDIATELY. Split from
// `awsEc2Allocator.test.ts` to keep each test file under the line cap.

import { describe, expect, it } from "vitest";
import {
  AwsEc2Allocator,
  AwsEc2AllocatorError,
  type AwsEc2Client,
  type AwsEc2Instance,
  type AwsRunInstancesInput,
} from "../src/engine/allocators/awsEc2Allocator.js";
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

class ScenarioFakeAwsEc2Client implements AwsEc2Client {
  private getCalls = 0;
  constructor(
    private readonly opts: {
      stuck?: boolean;
      unknownState?: string;
      terminalState?: string;
    } = {},
  ) {}
  async runInstances(_input: AwsRunInstancesInput): Promise<AwsEc2Instance> {
    return { instanceId: "i-1", state: "pending" };
  }
  async describeInstance(instanceId: string): Promise<AwsEc2Instance> {
    this.getCalls += 1;
    if (this.opts.terminalState !== undefined) {
      return { instanceId, state: this.opts.terminalState };
    }
    if (this.opts.unknownState !== undefined) {
      return { instanceId, state: this.opts.unknownState };
    }
    if (this.opts.stuck === true) {
      return { instanceId, state: "pending" };
    }
    if (this.getCalls >= 8) {
      return { instanceId, state: "running", publicIp: "203.0.113.7" };
    }
    const state = this.getCalls < 4 ? "pending" : "running";
    const publicIp = this.getCalls % 2 === 0 ? undefined : `intermediate-${this.getCalls}`;
    return { instanceId, state, publicIp };
  }
  async terminateInstance(): Promise<void> {}
}

function baseOpts(client: AwsEc2Client, runners: RunnerStore) {
  return {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    imageId: "ami-0abcd1234",
    instanceType: "t3.small",
    keyName: "tanren-runner",
    sshUsername: "ec2-user",
    hostKeyFingerprint: "SHA256:aws",
    runners,
    client,
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => undefined,
  };
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_aws",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const harness = {
  buildAdvancing() {
    const client = new ScenarioFakeAwsEc2Client();
    const runners = new FakeRunnerStore();
    return {
      allocator: new AwsEc2Allocator(baseOpts(client, runners)),
      request: req("run_adv"),
      expectedAdvancingProbes: 7,
    };
  },
  buildStuck() {
    const client = new ScenarioFakeAwsEc2Client({ stuck: true });
    const runners = new FakeRunnerStore();
    return {
      allocator: new AwsEc2Allocator(baseOpts(client, runners)),
      request: req("run_stuck"),
      expectedStuckSignature: "pending|no-ip",
    };
  },
  buildUnknownState() {
    const client = new ScenarioFakeAwsEc2Client({ unknownState: "hibernating-saving-state" });
    const runners = new FakeRunnerStore();
    return {
      allocator: new AwsEc2Allocator(baseOpts(client, runners)),
      request: req("run_unk"),
      expectedUnknownState: "hibernating-saving-state",
    };
  },
  buildTerminalArm(terminalState: string) {
    const client = new ScenarioFakeAwsEc2Client({ terminalState });
    const runners = new FakeRunnerStore();
    return {
      allocator: new AwsEc2Allocator(baseOpts(client, runners)),
      request: req("run_term"),
    };
  },
  // EC2's `AWS_EC2_TERMINAL_STATES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["terminated", "shutting-down", "stopping", "stopped"] as const,
};

describe("AwsEc2Allocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as AwsEc2AllocatorError with cause", async () => {
    const { allocator, request } = harness.buildTerminalArm("terminated");
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AwsEc2AllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

describeReadinessConvergence("AwsEc2", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, AwsEc2AllocatorError) };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, AwsEc2AllocatorError) };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, AwsEc2AllocatorError) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, AwsEc2AllocatorError) };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});
