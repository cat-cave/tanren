import { describe, expect, it } from "vitest";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import {
  RunnerLifecycle,
  type RunnerRecord,
  type RunnerSecretsClient,
  type RunnerStore,
} from "../src/runnerLifecycle.js";
import { AbandonedRunSweeper } from "../src/sweeper.js";

class NoopDocker implements DockerEngineClient {
  readonly removed: string[] = [];
  async createVolume(): Promise<void> {}
  async removeVolume(name: string): Promise<void> {
    this.removed.push(name);
  }
  async createContainer(_spec: CreateContainerSpec): Promise<string> {
    return "container";
  }
  async startContainer(): Promise<void> {}
  async inspectContainer(): Promise<ContainerInspectResult> {
    return { id: "container", imageSha: "sha256:noop", running: true };
  }
  async readContainerFile(): Promise<Buffer> {
    return Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRunnerHostKey runner\n");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(): Promise<void> {}
}

class MemoryStore implements RunnerStore {
  readonly records: RunnerRecord[] = [];
  async insert(record: RunnerRecord): Promise<void> {
    this.records.push({ ...record });
  }
  async markReleased(runnerId: string): Promise<RunnerRecord | undefined> {
    const record = this.records.find((r) => r.runnerId === runnerId && !r.released);
    if (record === undefined) return undefined;
    record.released = true;
    return record;
  }
  async findActive(runnerId: string): Promise<RunnerRecord | undefined> {
    return this.records.find((r) => r.runnerId === runnerId && !r.released);
  }
  async listActiveOlderThan(threshold: Date): Promise<RunnerRecord[]> {
    return this.records.filter((r) => !r.released && r.createdAt < threshold);
  }
}

class NoSecrets implements RunnerSecretsClient {
  async get(): Promise<string | undefined> {
    return undefined;
  }
}

describe("AbandonedRunSweeper", () => {
  it("reclaims runners older than maxRunHours and reports them via onReclaim", async () => {
    let nowMs = 1_700_000_000_000;
    const docker = new NoopDocker();
    const store = new MemoryStore();
    const lifecycle = new RunnerLifecycle({
      docker,
      store,
      secrets: new NoSecrets(),
      networkName: "tanren_default",
      sshHostnameForOrchestrator: (container) => container,
      sleep: () => Promise.resolve(),
      hostKeyReadAttempts: 1,
      hostKeyReadDelayMs: 0,
      now: () => new Date(nowMs),
    });

    await lifecycle.allocate({
      runId: "run_a",
      projectId: "proj_a",
      runnerImage: "img",
      vaultRefs: [],
    });

    nowMs += 7 * 60 * 60 * 1000;

    const reclaimed: RunnerRecord[] = [];
    const sweeper = new AbandonedRunSweeper({
      lifecycle,
      maxRunHours: 6,
      onReclaim: (record) => {
        reclaimed.push(record);
      },
    });

    const result = await sweeper.sweep();
    expect(result.map((r) => r.runnerId)).toEqual(["runner_run_a"]);
    expect(reclaimed.map((r) => r.runnerId)).toEqual(["runner_run_a"]);
    expect(docker.removed).toEqual(
      expect.arrayContaining(["tanren-runner-run_a-workspace", "tanren-runner-run_a-codex-home"]),
    );
  });

  it("is safe to call repeatedly with no stale runners", async () => {
    const docker = new NoopDocker();
    const store = new MemoryStore();
    const lifecycle = new RunnerLifecycle({
      docker,
      store,
      secrets: new NoSecrets(),
      networkName: "tanren_default",
      sshHostnameForOrchestrator: (container) => container,
      sleep: () => Promise.resolve(),
      hostKeyReadAttempts: 1,
      hostKeyReadDelayMs: 0,
    });
    const sweeper = new AbandonedRunSweeper({ lifecycle, maxRunHours: 6 });

    await expect(sweeper.sweep()).resolves.toEqual([]);
    await expect(sweeper.sweep()).resolves.toEqual([]);
  });
});
