// H10 hardening: the allocator's `/allocate` path writes a DURABLE, org-scoped
// audit record (other mutating surfaces do; allocate previously left none). These
// tests drive RunnerLifecycle.allocate against a fake docker + in-memory store and
// assert the recorded `AllocationAudit` shape for both a normal run (FK-valid
// run_id) and a runless Forge allocation (NULL run_id). The fakes are TEST FIXTURES.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunnerLifecycle, type AllocationAudit, type RunnerRecord, type RunnerStore } from "../src/runnerLifecycle.js";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";

// allocate() reads the runner's PUBLIC authorized-key (fail-closed on a blank key).
const ORIGINAL_AUTHORIZED_KEY = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
beforeAll(() => {
  process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrchestratorPub orchestrator";
});
afterAll(() => {
  if (ORIGINAL_AUTHORIZED_KEY === undefined) delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
  else process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = ORIGINAL_AUTHORIZED_KEY;
});

class AuditStore implements RunnerStore {
  readonly audits: AllocationAudit[] = [];
  async insert(): Promise<void> {}
  async recordAllocated(audit: AllocationAudit): Promise<void> {
    this.audits.push({ ...audit });
  }
  async recordSwept(): Promise<void> {}
  async markReleased(): Promise<RunnerRecord | undefined> {
    return undefined;
  }
  async findActive(): Promise<RunnerRecord | undefined> {
    return undefined;
  }
  async listActiveOlderThan(): Promise<RunnerRecord[]> {
    return [];
  }
  async listStuck(): Promise<never[]> {
    return [];
  }
}

class FakeDocker implements DockerEngineClient {
  async createVolume(): Promise<void> {}
  async removeVolume(): Promise<void> {}
  async createContainer(_spec: CreateContainerSpec): Promise<string> {
    return "container_1";
  }
  async startContainer(): Promise<void> {}
  async inspectContainer(id: string): Promise<ContainerInspectResult> {
    return { id, imageSha: "sha256:img", running: true };
  }
  async readContainerFile(): Promise<Buffer> {
    return Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRunnerHostKey runner\n");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
}

function lifecycleFor(store: RunnerStore): RunnerLifecycle {
  return new RunnerLifecycle({
    docker: new FakeDocker(),
    store,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    hostKeyReadAttempts: 1,
    hostKeyReadDelayMs: 0,
    sleep: async () => {},
  });
}

describe("RunnerLifecycle.allocate — durable allocation audit", () => {
  it("records an org-scoped audit with the FK-valid run_id for a normal run", async () => {
    const store = new AuditStore();
    await lifecycleFor(store).allocate({
      runId: "run_42",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      runnerId: "runner_run_42",
      runId: "run_42",
      projectId: "proj_a",
      orgId: "org_test",
      runless: false,
    });
  });

  it("records the audit with NULL run_id for a runless Forge allocation", async () => {
    const store = new AuditStore();
    await lifecycleFor(store).allocate({
      runId: "forge_org_test_abcd1234",
      projectId: "org:org_test",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      runless: true,
      persistedProjectId: null,
    });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      runnerId: "runner_forge_org_test_abcd1234",
      runId: null,
      projectId: null,
      orgId: "org_test",
      runless: true,
    });
  });
});
