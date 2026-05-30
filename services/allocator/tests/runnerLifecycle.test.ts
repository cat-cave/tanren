import { describe, expect, it } from "vitest";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import {
  RunnerLifecycle,
  type RunnerRecord,
  type RunnerSecretsClient,
  type RunnerStore,
} from "../src/runnerLifecycle.js";

class FakeDocker implements DockerEngineClient {
  readonly volumeCreates: string[] = [];
  readonly volumeRemoves: string[] = [];
  readonly containers: Array<{
    id: string;
    spec: CreateContainerSpec;
    started: boolean;
    removed: boolean;
    stopped: boolean;
  }> = [];
  hostKeyContent: Buffer = Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRunnerHostKey runner\n");
  failingHostKeyReads = 0;
  private hostKeyReads = 0;

  async createVolume(name: string): Promise<void> {
    this.volumeCreates.push(name);
  }

  async removeVolume(name: string): Promise<void> {
    this.volumeRemoves.push(name);
  }

  async createContainer(spec: CreateContainerSpec): Promise<string> {
    const id = `container_${this.containers.length + 1}`;
    this.containers.push({ id, spec, started: false, stopped: false, removed: false });
    return id;
  }

  async startContainer(id: string): Promise<void> {
    const entry = this.containers.find((c) => c.id === id);
    if (entry !== undefined) {
      entry.started = true;
    }
  }

  async inspectContainer(id: string): Promise<ContainerInspectResult> {
    const entry = this.containers.find((c) => c.id === id);
    return {
      id,
      imageSha: `sha256:${entry?.spec.image ?? "unknown"}`,
      running: entry?.started === true,
    };
  }

  async readContainerFile(): Promise<Buffer> {
    this.hostKeyReads += 1;
    if (this.hostKeyReads <= this.failingHostKeyReads) {
      throw new Error("not ready");
    }
    return this.hostKeyContent;
  }

  async stopContainer(id: string): Promise<void> {
    const entry = this.containers.find((c) => c.id === id);
    if (entry !== undefined) {
      entry.stopped = true;
    }
  }

  async removeContainer(id: string): Promise<void> {
    const entry = this.containers.find((c) => c.id === id);
    if (entry !== undefined) {
      entry.removed = true;
    }
  }
}

class InMemoryRunnerStore implements RunnerStore {
  readonly records: RunnerRecord[] = [];

  async insert(record: RunnerRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async markReleased(runnerId: string): Promise<RunnerRecord | undefined> {
    const record = this.records.find((r) => r.runnerId === runnerId && !r.released);
    if (record === undefined) {
      return undefined;
    }
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

class StaticSecrets implements RunnerSecretsClient {
  constructor(private readonly values: Record<string, string>) {}
  async get(ref: string): Promise<string | undefined> {
    return this.values[ref];
  }
}

const baseLifecycle = (
  docker: FakeDocker,
  store: InMemoryRunnerStore,
  secrets: RunnerSecretsClient = new StaticSecrets({}),
  now?: () => Date,
) =>
  new RunnerLifecycle({
    docker,
    store,
    secrets,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    hostKeyReadAttempts: 4,
    hostKeyReadDelayMs: 1,
    sleep: () => Promise.resolve(),
    now,
  });

describe("RunnerLifecycle.allocate", () => {
  it("creates per-run volumes, starts a container, and returns the SSH target", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const result = await lifecycle.allocate({
      runId: "run_42",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    expect(result.runnerId).toBe("runner_run_42");
    expect(result.sshHost).toBe("tanren-runner-run_42");
    expect(result.sshPort).toBe(22);
    expect(result.hostKeyFingerprint.startsWith("SHA256:")).toBe(true);
    expect(docker.volumeCreates).toEqual(["tanren-runner-run_42-workspace", "tanren-runner-run_42-codex-home"]);
    expect(docker.containers[0]?.started).toBe(true);
    expect(docker.containers[0]?.spec.env.TANREN_RUNNER_EPHEMERAL).toBe("1");
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.released).toBe(false);
  });

  it("materializes vault refs into the codex-home env bundle", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const secrets = new StaticSecrets({ "credential/codex/test": '{"openai":{}}' });
    const lifecycle = baseLifecycle(docker, store, secrets);

    await lifecycle.allocate({
      runId: "run_codex",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: ["credential/codex/test"],
    });

    const bundle = docker.containers[0]?.spec.env.TANREN_CODEX_HOME_BUNDLE ?? "";
    expect(bundle).not.toBe("");
    const decoded = JSON.parse(Buffer.from(bundle, "base64").toString("utf8")) as Array<{
      ref: string;
      value: string;
    }>;
    expect(decoded).toEqual([{ ref: "credential/codex/test", value: '{"openai":{}}' }]);
  });

  it("fails when a vault ref is missing", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store, new StaticSecrets({}));

    await expect(
      lifecycle.allocate({
        runId: "run_missing",
        projectId: "proj_a",
        runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
        vaultRefs: ["credential/missing"],
      }),
    ).rejects.toThrow(/credential\/missing/u);
  });

  it("retries host-key reads while sshd is still generating keys", async () => {
    const docker = new FakeDocker();
    docker.failingHostKeyReads = 2;
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const result = await lifecycle.allocate({
      runId: "run_slow",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    expect(result.hostKeyFingerprint.startsWith("SHA256:")).toBe(true);
  });
});

describe("RunnerLifecycle.release", () => {
  it("stops the container, removes it, and wipes both volumes", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const allocated = await lifecycle.allocate({
      runId: "run_release",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    const result = await lifecycle.release(allocated.runnerId, "completed");

    expect(result.released).toBe(true);
    expect(docker.containers[0]?.stopped).toBe(true);
    expect(docker.containers[0]?.removed).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_release-workspace", "tanren-runner-run_release-codex-home"]),
    );
    expect(store.records[0]?.released).toBe(true);
  });

  it("is idempotent: a second release is a no-op", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const allocated = await lifecycle.allocate({
      runId: "run_idemp",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });
    await lifecycle.release(allocated.runnerId, "completed");
    const removeCallsAfterFirst = docker.volumeRemoves.length;
    const result = await lifecycle.release(allocated.runnerId, "completed");
    expect(result.released).toBe(false);
    expect(docker.volumeRemoves.length).toBe(removeCallsAfterFirst);
  });

  it("wipes volumes on a failed release as well", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const allocated = await lifecycle.allocate({
      runId: "run_failed",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });
    const result = await lifecycle.release(allocated.runnerId, "failed");

    expect(result.released).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_failed-workspace", "tanren-runner-run_failed-codex-home"]),
    );
  });
});

describe("RunnerLifecycle.sweepAbandoned", () => {
  it("reclaims runners older than the TTL with reason 'abandoned'", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    let nowMs = 1_000_000_000_000;
    const lifecycle = baseLifecycle(docker, store, new StaticSecrets({}), () => new Date(nowMs));

    await lifecycle.allocate({
      runId: "run_stale",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    // Advance the simulated clock by 7 hours; TTL is 6h.
    nowMs += 7 * 60 * 60 * 1000;

    const reclaimed = await lifecycle.sweepAbandoned(6 * 60 * 60 * 1000);

    expect(reclaimed.map((r) => r.runnerId)).toEqual(["runner_run_stale"]);
    expect(docker.containers[0]?.removed).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_stale-workspace", "tanren-runner-run_stale-codex-home"]),
    );
  });

  it("leaves recent runners alone", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    let nowMs = 1_000_000_000_000;
    const lifecycle = baseLifecycle(docker, store, new StaticSecrets({}), () => new Date(nowMs));

    await lifecycle.allocate({
      runId: "run_fresh",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    nowMs += 60 * 60 * 1000; // 1h
    const reclaimed = await lifecycle.sweepAbandoned(6 * 60 * 60 * 1000);

    expect(reclaimed).toEqual([]);
    expect(docker.containers[0]?.removed).toBe(false);
  });
});

describe("RunnerLifecycle finalizer under simulated crash", () => {
  it("still wipes volumes when the container has already exited before release", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const allocated = await lifecycle.allocate({
      runId: "run_crash",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: [],
    });

    // Simulate the container crashing: mark it stopped from the outside.
    const container = docker.containers[0];
    if (container !== undefined) {
      container.started = false;
    }

    const result = await lifecycle.release(allocated.runnerId, "failed");
    expect(result.released).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_crash-workspace", "tanren-runner-run_crash-codex-home"]),
    );
  });
});
