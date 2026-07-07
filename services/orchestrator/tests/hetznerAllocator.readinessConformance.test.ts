// Task #31: per-allocator readiness convergence conformance for Hetzner.
//
// Pins the 4-scenario contract at the Hetzner-specific wiring. The advancing
// harness threads CHANGING server statuses across probes (`initializing|no-ip`
// → `starting|no-ip` → `running|no-ip` → `running|ip`). The stuck harness
// pins `initializing|no-ip`. Split from `hetznerAllocator.test.ts` to keep
// each test file under the line cap. Note: HetznerAllocator throws plain
// `Error` (not a typed allocator class) so the unwrap adapter strips the
// `.cause` directly.

import { describe, expect, it } from "vitest";
import {
  HetznerAllocator,
  type HetznerClient,
  type HetznerServer,
  type HetznerSshKey,
} from "../src/engine/allocators/hetznerAllocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
} from "../src/engine/allocators/readinessConvergence.js";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { generateEd25519KeyPair, type EphemeralKeyPair } from "../src/engine/ssh/keygen.js";
import { describeReadinessConvergence } from "./conformance/readinessConvergenceConformance.js";

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

class ScenarioFakeHetznerClient implements HetznerClient {
  private getCalls = 0;
  constructor(
    private readonly opts: {
      stuck?: boolean;
      unknownStatus?: string;
      terminalStatus?: string;
    } = {},
  ) {}
  async createSshKey(): Promise<HetznerSshKey> {
    return { id: 555 };
  }
  async deleteSshKey(): Promise<void> {}
  async createServer(): Promise<HetznerServer> {
    return { id: 42, status: "initializing", publicIpv4: undefined };
  }
  async getServer(serverId: number): Promise<HetznerServer> {
    this.getCalls += 1;
    if (this.opts.terminalStatus !== undefined) {
      return { id: serverId, status: this.opts.terminalStatus };
    }
    if (this.opts.unknownStatus !== undefined) {
      return { id: serverId, status: this.opts.unknownStatus };
    }
    if (this.opts.stuck === true) {
      return { id: serverId, status: "initializing" };
    }
    if (this.getCalls >= 8) {
      return { id: serverId, status: "running", publicIpv4: "203.0.113.10" };
    }
    const status = this.getCalls < 3 ? "initializing" : this.getCalls < 5 ? "starting" : "running";
    const publicIpv4 = this.getCalls % 2 === 0 ? undefined : `intermediate-${this.getCalls}`;
    return { id: serverId, status, publicIpv4 };
  }
  async deleteServer(): Promise<void> {}
}

function deterministicKeySeq(): { gen: () => EphemeralKeyPair } {
  const hostKey = generateEd25519KeyPair();
  const seq = [
    { privateKey: "CLIENT-CONF-FAKE", publicKey: "ssh-ed25519 AAAAClient tanren" } as EphemeralKeyPair,
    hostKey,
  ];
  let i = 0;
  return { gen: (): EphemeralKeyPair => seq[i++ % seq.length] as EphemeralKeyPair };
}

function baseOpts(client: HetznerClient, runners: RunnerStore, secrets: InMemorySecretStore) {
  return {
    apiToken: "tok",
    serverType: "cx22",
    image: "docker-ce",
    location: "nbg1",
    runners,
    secrets,
    client,
    generateKeyPair: deterministicKeySeq().gen,
    pollIntervalMs: 1,
    sleep: async (): Promise<void> => undefined,
  };
}

function req(runId: string) {
  return {
    runId,
    projectId: "proj_h",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

const harness = {
  buildAdvancing() {
    const client = new ScenarioFakeHetznerClient();
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    return {
      allocator: new HetznerAllocator(baseOpts(client, runners, secrets)),
      request: req("run_adv"),
      expectedAdvancingProbes: 7,
    };
  },
  buildStuck() {
    const client = new ScenarioFakeHetznerClient({ stuck: true });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    return {
      allocator: new HetznerAllocator(baseOpts(client, runners, secrets)),
      request: req("run_stuck"),
      expectedStuckSignature: "initializing|no-ip",
    };
  },
  buildUnknownState() {
    const client = new ScenarioFakeHetznerClient({ unknownStatus: "performing-magic" });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    return {
      allocator: new HetznerAllocator(baseOpts(client, runners, secrets)),
      request: req("run_unk"),
      expectedUnknownState: "performing-magic",
    };
  },
  buildTerminalArm(terminalState: string) {
    const client = new ScenarioFakeHetznerClient({ terminalStatus: terminalState });
    const runners = new FakeRunnerStore();
    const secrets = new InMemorySecretStore();
    return {
      allocator: new HetznerAllocator(baseOpts(client, runners, secrets)),
      request: req("run_term"),
    };
  },
  // Hetzner `HETZNER_TERMINAL_STATUSES` allowlist — each fires the terminal arm IMMEDIATELY.
  expectedTerminalArms: ["stopping", "off", "deleting", "unknown"] as const,
};

describe("HetznerAllocator — readiness convergence inner contract", () => {
  it("wraps PersistentProvisioningOutageError as Error with cause", async () => {
    const { allocator, request } = harness.buildStuck();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(PersistentProvisioningOutageError);
  });

  it("wraps UnknownProvisioningStateError as Error with cause", async () => {
    const { allocator, request } = harness.buildUnknownState();
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(UnknownProvisioningStateError);
  });

  it("wraps ProvisioningTerminalStateError as Error with cause", async () => {
    const { allocator, request } = harness.buildTerminalArm("off");
    const caught = await allocator.allocate(request).catch((error: unknown) => error);
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ProvisioningTerminalStateError);
  });
});

// Hetzner throws plain Error (not a typed allocator class), so the unwrap
// adapter reads the cause directly off any Error rather than discriminating
// on a wrapper class. Acceptable here: the conformance suite owns the seam.
function unwrapHetzner(allocator: Allocator): Allocator {
  return {
    async allocate(request) {
      try {
        return await allocator.allocate(request);
      } catch (error) {
        if (error instanceof Error && (error as { cause?: unknown }).cause !== undefined) {
          throw (error as { cause: unknown }).cause;
        }
        throw error;
      }
    },
    release: allocator.release.bind(allocator),
  };
}

describeReadinessConvergence("Hetzner", {
  buildAdvancing: () => {
    const inner = harness.buildAdvancing();
    return { ...inner, allocator: unwrapHetzner(inner.allocator) };
  },
  buildStuck: () => {
    const inner = harness.buildStuck();
    return { ...inner, allocator: unwrapHetzner(inner.allocator) };
  },
  buildUnknownState: () => {
    const inner = harness.buildUnknownState();
    return { ...inner, allocator: unwrapHetzner(inner.allocator) };
  },
  buildTerminalArm: (terminalState) => {
    const inner = harness.buildTerminalArm(terminalState);
    return { ...inner, allocator: unwrapHetzner(inner.allocator) };
  },
  expectedTerminalArms: harness.expectedTerminalArms,
});
