import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import { RunnerLifecycle, type RunnerRecord, type RunnerStore } from "../src/runnerLifecycle.js";

// allocate() resolves the runner's PUBLIC authorized_keys via the fail-closed
// requireRunnerAuthorizedKey() (no silent `?? ""`); every allocate test needs it set.
const ORIGINAL_AUTHORIZED_KEY = process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
beforeAll(() => {
  process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrchestratorPub orchestrator";
});
afterAll(() => {
  if (ORIGINAL_AUTHORIZED_KEY === undefined) {
    delete process.env["TANREN_RUNNER_AUTHORIZED_KEY"];
  } else {
    process.env["TANREN_RUNNER_AUTHORIZED_KEY"] = ORIGINAL_AUTHORIZED_KEY;
  }
});

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
  // When true, a started container is reported as NOT running (a crashed/exited boot):
  // the boot-readiness probe gives up LOUD only on this genuine death, never on a count.
  containerDeadOnBoot = false;
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
      running: entry?.started === true && !this.containerDeadOnBoot,
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
  async recordAllocated(): Promise<void> {}
  async recordSwept(): Promise<void> {}
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

  // The stuck-sweep is exercised in sweeper.test.ts; this store stubs it out.
  async listStuck(): Promise<never[]> {
    return [];
  }
}

const baseLifecycle = (docker: FakeDocker, store: InMemoryRunnerStore, now?: () => Date) =>
  new RunnerLifecycle({
    docker,
    store,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
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
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
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
    // A normal run persists its FK-valid run_id/project_id.
    expect(store.records[0]?.runId).toBe("run_42");
    expect(store.records[0]?.projectId).toBe("proj_a");
    expect(store.records[0]?.handle).toBe("run_42");
  });

  it("runless Forge ideation: NULL run_id/project_id persisted, handle drives naming", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    // The greenfield-interview shape: synthetic handle, runless, no persisted project (naming still uses the handle).
    const result = await lifecycle.allocate({
      runId: "forge_org_test_abcd1234",
      projectId: "org:org_test",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      runless: true,
      persistedProjectId: null,
    });

    expect(result.runnerId).toBe("runner_forge_org_test_abcd1234");
    expect(docker.volumeCreates).toEqual([
      "tanren-runner-forge_org_test_abcd1234-workspace",
      "tanren-runner-forge_org_test_abcd1234-codex-home",
    ]);
    // The persisted runners row has NULL run_id/project_id (no FK target); org_id is real; the handle is kept for naming/recovery.
    expect(store.records[0]?.runId).toBeNull();
    expect(store.records[0]?.projectId).toBeNull();
    expect(store.records[0]?.orgId).toBe("org_test");
    expect(store.records[0]?.handle).toBe("forge_org_test_abcd1234");
  });

  it("runless project-scoped surface: NULL run_id but the REAL project_id persisted", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    await lifecycle.allocate({
      runId: "forge_proj_a_abcd1234",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      runless: true,
      persistedProjectId: "proj_a",
    });

    // run_id NULL (no `runs` row), project_id the real FK-valid project.
    expect(store.records[0]?.runId).toBeNull();
    expect(store.records[0]?.projectId).toBe("proj_a");
  });

  it("delivers NO secret VALUE to the runner via Docker env (the bundle channel is gone)", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    await lifecycle.allocate({
      runId: "run_codex",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });

    // The only env on the runner is the PUBLIC authorized_keys line + the
    // ephemeral marker. There is no TANREN_CODEX_HOME_BUNDLE (removed) and no
    // secret value of any kind — `docker inspect` carries nothing sensitive.
    const env = docker.containers[0]?.spec.env ?? {};
    expect(Object.keys(env).sort()).toEqual(["TANREN_RUNNER_AUTHORIZED_KEY", "TANREN_RUNNER_EPHEMERAL"]);
    expect("TANREN_CODEX_HOME_BUNDLE" in env).toBe(false);
    // The resolved (non-empty) authorized key flows into the runner env — never `""`.
    expect(env.TANREN_RUNNER_AUTHORIZED_KEY).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrchestratorPub orchestrator");
  });

  it("retries host-key reads while sshd is still generating keys", async () => {
    const docker = new FakeDocker();
    docker.failingHostKeyReads = 2;
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const result = await lifecycle.allocate({
      runId: "run_slow",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
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
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
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
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
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
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });
    const result = await lifecycle.release(allocated.runnerId, "failed");

    expect(result.released).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_failed-workspace", "tanren-runner-run_failed-codex-home"]),
    );
  });
});

describe("RunnerLifecycle.allocate partial-failure teardown (no-orphan guard)", () => {
  it("(a) throws after createContainer → BOTH volumes + the container are removed", async () => {
    const docker = new FakeDocker();
    // Make the step AFTER createContainer (startContainer) throw, so the
    // container exists when we unwind.
    docker.startContainer = async (id: string) => {
      const entry = docker.containers.find((c) => c.id === id);
      if (entry !== undefined) {
        entry.started = true;
      }
      throw new Error("docker start exploded");
    };
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    await expect(
      lifecycle.allocate({
        runId: "run_partial",
        projectId: "proj_a",
        orgId: "org_test",
        runnerImage: "img",
      }),
    ).rejects.toThrow(/docker start exploded/u);

    // No DB row was written, so release/sweep could never reach this state —
    // the teardown is the ONLY thing that prevents the orphan.
    expect(store.records).toHaveLength(0);
    // The container created before the throw is removed.
    expect(docker.containers[0]?.removed).toBe(true);
    // BOTH volumes are removed by deterministic name.
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_partial-workspace", "tanren-runner-run_partial-codex-home"]),
    );
  });

  it("(b) host-key boot fails on a DEAD container → container + both volumes are gone", async () => {
    const docker = new FakeDocker();
    // The host key never appears AND the container is observed DEAD (a crashed boot):
    // the readiness probe gives up LOUD only on this genuine death (no attempt cap).
    docker.failingHostKeyReads = 1_000;
    docker.containerDeadOnBoot = true;
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    await expect(
      lifecycle.allocate({
        runId: "run_no_host_key",
        projectId: "proj_a",
        orgId: "org_test",
        runnerImage: "img",
      }),
    ).rejects.toThrow(/exited before exposing an SSH host key/u);

    expect(store.records).toHaveLength(0);
    expect(docker.containers[0]?.removed).toBe(true);
    expect(docker.volumeRemoves).toEqual(
      expect.arrayContaining(["tanren-runner-run_no_host_key-workspace", "tanren-runner-run_no_host_key-codex-home"]),
    );
  });

  it("a still-booting (live) container is polled until the host key appears — never an attempt cap", async () => {
    const docker = new FakeDocker();
    // sshd is slow: the first reads fail while the container stays RUNNING. The probe
    // must keep polling (no give-up) and succeed once the key lands — a long boot is
    // never abandoned by a fixed count.
    docker.failingHostKeyReads = 50;
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const result = await lifecycle.allocate({
      runId: "run_slow_boot",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "img",
    });

    expect(result.runnerId).toBe("runner_run_slow_boot");
    expect(store.records).toHaveLength(1);
  });

  it("teardown is best-effort: a removeVolume failure does NOT mask the original error", async () => {
    const docker = new FakeDocker();
    docker.failingHostKeyReads = 1_000;
    docker.containerDeadOnBoot = true;
    // Teardown itself fails — the ORIGINAL error must still surface.
    docker.removeVolume = async () => {
      throw new Error("removeVolume also exploded");
    };
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    await expect(
      lifecycle.allocate({ runId: "run_mask", projectId: "proj_a", orgId: "org_test", runnerImage: "img" }),
    ).rejects.toThrow(/exited before exposing an SSH host key/u);
  });

  it("(d-lifecycle) a retried allocate on a LIVE runner returns the existing target, no second container", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const first = await lifecycle.allocate({
      runId: "run_retry",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "img",
    });
    const second = await lifecycle.allocate({
      runId: "run_retry",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "img",
    });

    // Same SSH target, the SAME single container — never overwritten/duplicated.
    expect(second).toEqual(first);
    expect(docker.containers).toHaveLength(1);
    expect(store.records).toHaveLength(1);
  });
});

describe("RunnerLifecycle.release concurrent double-teardown (claim gate)", () => {
  it("(c) two concurrent release() → exactly ONE Docker teardown; one claimed, one not", async () => {
    const docker = new FakeDocker();
    const store = new InMemoryRunnerStore();
    const lifecycle = baseLifecycle(docker, store);

    const allocated = await lifecycle.allocate({
      runId: "run_race",
      projectId: "proj_a",
      orgId: "org_test",
      runnerImage: "img",
    });

    const [a, b] = await Promise.all([
      lifecycle.release(allocated.runnerId, "completed"),
      lifecycle.release(allocated.runnerId, "completed"),
    ]);

    // Exactly one winner.
    expect([a.released, b.released].filter(Boolean)).toHaveLength(1);
    expect([a.released, b.released].filter((r) => !r)).toHaveLength(1);
    // The container is removed exactly once; the two volumes wiped exactly once each.
    expect(docker.containers.filter((c) => c.removed)).toHaveLength(1);
    expect(docker.volumeRemoves.filter((v) => v === "tanren-runner-run_race-workspace")).toHaveLength(1);
    expect(docker.volumeRemoves.filter((v) => v === "tanren-runner-run_race-codex-home")).toHaveLength(1);
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
      orgId: "org_test",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
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
