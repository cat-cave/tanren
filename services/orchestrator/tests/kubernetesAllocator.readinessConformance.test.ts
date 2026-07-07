// Task #31: per-allocator readiness convergence conformance for Kubernetes.
//
// K8s structural signature folds Pod phase + IP-presence + SORTED conditions +
// SORTED container states — so the kubelet retrying `ImagePullBackOff`
// (changes when kubelet retries → `back-off N`) advances the signature, but a
// stuck `ImagePullBackOff` (or stuck `Pending|no-ip|no-conds|no-cstats`) does not.
// Split from `kubernetesAllocator.test.ts` to keep each test file under the
// line cap.

import { describe, expect, it } from "vitest";
import {
  KubernetesAllocator,
  KubernetesAllocatorError,
  type KubernetesClient,
  type KubernetesPod,
  type KubernetesPodInput,
} from "../src/engine/allocators/kubernetesAllocator.js";
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

class ScenarioFakeKubernetesClient implements KubernetesClient {
  private getCalls = 0;
  constructor(
    private readonly opts: {
      stuck?: boolean;
      unknownPhase?: string;
      terminalPhase?: string;
    } = {},
  ) {}
  async createSecret(): Promise<void> {}
  async createPod(input: KubernetesPodInput): Promise<KubernetesPod> {
    return { name: input.name, phase: "Pending" };
  }
  async getPod(name: string): Promise<KubernetesPod> {
    this.getCalls += 1;
    if (this.opts.terminalPhase !== undefined) {
      return { name, phase: this.opts.terminalPhase };
    }
    if (this.opts.unknownPhase !== undefined) {
      return { name, phase: this.opts.unknownPhase };
    }
    if (this.opts.stuck === true) {
      return { name, phase: "Pending" };
    }
    if (this.getCalls >= 8) {
      return {
        name,
        phase: "Running",
        podIp: "10.1.2.3",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [{ name: "runner", state: "running" }],
      };
    }
    // Each intermediate probe surfaces a different condition / container state
    // so the structural signature ADVANCES forward.
    return {
      name,
      phase: this.getCalls < 4 ? "Pending" : "Running",
      podIp: undefined,
      conditions: [
        { type: "PodScheduled", status: this.getCalls % 2 === 0 ? "True" : "False" },
        { type: `Initialized-step-${this.getCalls}`, status: "False" },
      ],
      containerStatuses: [{ name: "runner", state: `waiting:Step-${this.getCalls}` }],
    };
  }
  async deletePod(): Promise<void> {}
  async deleteSecret(): Promise<void> {}
}

function baseOpts(client: KubernetesClient, runners: RunnerStore) {
  return {
    apiServer: "https://10.0.0.1:6443",
    token: "sa-token",
    namespace: "tanren-runners",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    sshPublicKey: "ssh-ed25519 AAAA...",
    sshUsername: "tanren",
    hostKeyFingerprint: "SHA256:k8s",
    runners,
    client,
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => undefined,
  };
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_k8s",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const harness = {
  buildAdvancing() {
    const client = new ScenarioFakeKubernetesClient();
    const runners = new FakeRunnerStore();
    return {
      allocator: new KubernetesAllocator(baseOpts(client, runners)),
      request: req("run_adv"),
      expectedAdvancingProbes: 7,
    };
  },
  buildStuck() {
    const client = new ScenarioFakeKubernetesClient({ stuck: true });
    const runners = new FakeRunnerStore();
    return {
      allocator: new KubernetesAllocator(baseOpts(client, runners)),
      request: req("run_stuck"),
      expectedStuckSignature: "Pending|no-ip|no-conds|no-cstats",
    };
  },
  buildUnknownState() {
    const client = new ScenarioFakeKubernetesClient({ unknownPhase: "Quiescing" });
    const runners = new FakeRunnerStore();
    return {
      allocator: new KubernetesAllocator(baseOpts(client, runners)),
      request: req("run_unk"),
      expectedUnknownState: "Quiescing",
    };
  },
  buildTerminalArm(terminalState: string) {
    const client = new ScenarioFakeKubernetesClient({ terminalPhase: terminalState });
    const runners = new FakeRunnerStore();
    return {
      allocator: new KubernetesAllocator(baseOpts(client, runners)),
      request: req("run_term"),
    };
  },
  // K8s `K8S_TERMINAL_PHASES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["Failed", "Succeeded", "Unknown"] as const,
};

describe("KubernetesAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as KubernetesAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KubernetesAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as KubernetesAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KubernetesAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as KubernetesAllocatorError with cause", async () => {
    const { allocator, request } = harness.buildTerminalArm("Failed");
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KubernetesAllocatorError);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

describeReadinessConvergence("Kubernetes", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, KubernetesAllocatorError) };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, KubernetesAllocatorError) };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, KubernetesAllocatorError) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapCauseAllocator(inner.allocator, KubernetesAllocatorError) };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});
