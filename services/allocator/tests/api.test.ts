import { describe, expect, it } from "vitest";
import { createAllocatorApi } from "../src/api.js";
import type {
  ContainerInspectResult,
  CreateContainerSpec,
  DockerEngineClient
} from "../src/dockerEngine.js";
import {
  RunnerLifecycle,
  type RunnerRecord,
  type RunnerSecretsClient,
  type RunnerStore
} from "../src/runnerLifecycle.js";

class FakeDocker implements DockerEngineClient {
  readonly volumeCreates: string[] = [];
  readonly volumeRemoves: string[] = [];
  readonly containers: Array<{ id: string; spec: CreateContainerSpec; removed: boolean }> = [];

  async createVolume(name: string): Promise<void> {
    this.volumeCreates.push(name);
  }
  async removeVolume(name: string): Promise<void> {
    this.volumeRemoves.push(name);
  }
  async createContainer(spec: CreateContainerSpec): Promise<string> {
    const id = `container_${this.containers.length + 1}`;
    this.containers.push({ id, spec, removed: false });
    return id;
  }
  async startContainer(): Promise<void> {}
  async inspectContainer(id: string): Promise<ContainerInspectResult> {
    return { id, imageSha: "sha256:fake", running: true };
  }
  async readContainerFile(): Promise<Buffer> {
    return Buffer.from("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRunnerHostKey runner\n");
  }
  async stopContainer(): Promise<void> {}
  async removeContainer(id: string): Promise<void> {
    const entry = this.containers.find((c) => c.id === id);
    if (entry !== undefined) {
      entry.removed = true;
    }
  }
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
  async listActiveOlderThan(): Promise<RunnerRecord[]> {
    return [];
  }
}

class StaticSecrets implements RunnerSecretsClient {
  async get(): Promise<string | undefined> {
    return undefined;
  }
}

function buildApp() {
  const docker = new FakeDocker();
  const store = new MemoryStore();
  const lifecycle = new RunnerLifecycle({
    docker,
    store,
    secrets: new StaticSecrets(),
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    sleep: () => Promise.resolve(),
    hostKeyReadAttempts: 1,
    hostKeyReadDelayMs: 0
  });
  const app = createAllocatorApi({
    lifecycle,
    authToken: "test-token",
    dockerPing: async () => true
  });
  return { app, docker, store, lifecycle };
}

async function postJson(app: { fetch: (req: Request) => Promise<Response> }, path: string, body: unknown, token = "test-token"): Promise<Response> {
  return app.fetch(
    new Request(`http://allocator${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
  );
}

describe("allocator HTTP API", () => {
  it("returns 401 without the bearer token on /allocate", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://allocator/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "run_1", projectId: "p", runnerImage: "img", vaultRefs: [] })
      })
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 on a malformed /allocate body", async () => {
    const { app } = buildApp();
    const response = await postJson(app, "/allocate", { wrong: true });
    expect(response.status).toBe(400);
  });

  it("allocates and releases successfully", async () => {
    const { app, docker, store } = buildApp();

    const allocated = await postJson(app, "/allocate", {
      runId: "run_api",
      projectId: "proj",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      vaultRefs: []
    });
    expect(allocated.status).toBe(201);
    const allocatedBody = (await allocated.json()) as { runnerId: string };
    expect(allocatedBody.runnerId).toBe("runner_run_api");

    const released = await postJson(app, "/release", { runnerId: allocatedBody.runnerId, reason: "completed" });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    expect(docker.containers[0]?.removed).toBe(true);
    expect(store.records[0]?.released).toBe(true);
  });

  it("/release on an unknown runner returns released: false", async () => {
    const { app } = buildApp();
    const response = await postJson(app, "/release", { runnerId: "runner_missing", reason: "completed" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: false });
  });

  it("/healthz reports docker reachability", async () => {
    const { app } = buildApp();
    const response = await app.fetch(new Request("http://allocator/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "allocator", ok: true });
  });
});
