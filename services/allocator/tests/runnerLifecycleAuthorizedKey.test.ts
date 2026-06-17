// §5 (v30 empty-sentinel class): allocate() must FAIL CLOSED — a loud throw — when
// TANREN_RUNNER_AUTHORIZED_KEY is unset/blank, BEFORE any side effect. An empty key
// would silently produce a runner whose sshd trusts no key (un-SSH-able), spending a
// container/volume on a runner the orchestrator can never reach. Kept in its own file
// so runnerLifecycle.test.ts stays under the 500-line cap.

import { describe, expect, it } from "vitest";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import { RunnerLifecycle, type RunnerRecord, type RunnerStore } from "../src/runnerLifecycle.js";

class FakeDocker implements DockerEngineClient {
  readonly volumeCreates: string[] = [];
  readonly containers: string[] = [];
  async createVolume(name: string): Promise<void> {
    this.volumeCreates.push(name);
  }
  async removeVolume(): Promise<void> {}
  async createContainer(_spec: CreateContainerSpec): Promise<string> {
    const id = `container_${this.containers.length + 1}`;
    this.containers.push(id);
    return id;
  }
  async startContainer(): Promise<void> {}
  async inspectContainer(id: string): Promise<ContainerInspectResult> {
    return { id, imageSha: "sha256:x", running: true };
  }
  async readContainerFile(): Promise<Buffer> {
    return Buffer.from("ssh-ed25519 AAAAHostKey runner\n");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
}

class InMemoryRunnerStore implements RunnerStore {
  readonly records: RunnerRecord[] = [];
  async insert(record: RunnerRecord): Promise<void> {
    this.records.push({ ...record });
  }
  async recordAllocated(): Promise<void> {}
  async recordSwept(): Promise<void> {}
  async markReleased(): Promise<RunnerRecord | undefined> {
    return undefined;
  }
  async findActive(): Promise<RunnerRecord | undefined> {
    return undefined;
  }
  async listStuck(): Promise<never[]> {
    return [];
  }
}

function lifecycleFor(docker: FakeDocker, store: InMemoryRunnerStore): RunnerLifecycle {
  return new RunnerLifecycle({
    docker,
    store,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    hostKeyReadDelayMs: 1,
    sleep: () => Promise.resolve(),
  });
}

describe("RunnerLifecycle.allocate — fail-closed on a missing authorized key (§5)", () => {
  const restore = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
  const reset = () => {
    if (restore === undefined) {
      delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
    } else {
      process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = restore;
    }
  };

  it('throws LOUD (no silent `?? ""`) on a BLANK key, before any side effect', async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = lifecycleFor(docker, store);
    process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "";
    try {
      await expect(
        lifecycle.allocate({ runId: "run_blank", projectId: "proj_a", orgId: "org_test", runnerImage: "img" }),
      ).rejects.toThrow(/TANREN_RUNNER_AUTHORIZED_KEY is required/u);
      // No volumes, no container, no DB row — the alloc spent nothing.
      expect(docker.volumeCreates).toHaveLength(0);
      expect(docker.containers).toHaveLength(0);
      expect(store.records).toHaveLength(0);
    } finally {
      reset();
    }
  });

  it("throws LOUD when the key is UNSET entirely", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = lifecycleFor(docker, store);
    delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
    try {
      await expect(
        lifecycle.allocate({ runId: "run_unset", projectId: "proj_a", orgId: "org_test", runnerImage: "img" }),
      ).rejects.toThrow(/TANREN_RUNNER_AUTHORIZED_KEY is required/u);
    } finally {
      reset();
    }
  });
});
