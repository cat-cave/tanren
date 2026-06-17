import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAllocatorApi } from "../src/api.js";
import type { ContainerInspectResult, CreateContainerSpec, DockerEngineClient } from "../src/dockerEngine.js";
import { RunnerLifecycle, type RunnerRecord, type RunnerStore } from "../src/runnerLifecycle.js";

// allocate() fail-closes on a blank TANREN_RUNNER_AUTHORIZED_KEY; provide one.
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
  async recordAllocated(): Promise<void> {
    // The API tests assert HTTP behavior, not the audit row (covered in the
    // lifecycle unit tests); a no-op stub satisfies the RunnerStore contract.
  }
  async recordSwept(): Promise<void> {}
  async markReleased(runnerId: string): Promise<RunnerRecord | undefined> {
    const record = this.records.find((r) => r.runnerId === runnerId && !r.released);
    if (record === undefined) return undefined;
    record.released = true;
    return record;
  }
  async findActive(runnerId: string): Promise<RunnerRecord | undefined> {
    return this.records.find((r) => r.runnerId === runnerId && !r.released);
  }
  async listStuck(): Promise<never[]> {
    return [];
  }
}

function buildApp() {
  const docker = new FakeDocker();
  const store = new MemoryStore();
  const lifecycle = new RunnerLifecycle({
    docker,
    store,
    networkName: "tanren_default",
    sshHostnameForOrchestrator: (container) => container,
    sleep: () => Promise.resolve(),
    hostKeyReadDelayMs: 0,
  });
  const app = createAllocatorApi({
    lifecycle,
    authToken: "test-token",
    dockerPing: async () => true,
  });
  return { app, docker, store, lifecycle };
}

async function postJson(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  body: unknown,
  token = "test-token",
): Promise<Response> {
  return app.fetch(
    new Request(`http://allocator${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

describe("allocator HTTP API", () => {
  it("returns 401 without the bearer token on /allocate", async () => {
    const { app } = buildApp();
    const response = await app.fetch(
      new Request("http://allocator/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: "run_1", projectId: "p", runnerImage: "img" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 on a malformed /allocate body", async () => {
    const { app } = buildApp();
    const response = await postJson(app, "/allocate", { wrong: true });
    expect(response.status).toBe(400);
  });

  it("rejects an /allocate request with no orgId (de-priv: never write off-RLS)", async () => {
    const { app, store } = buildApp();
    const response = await postJson(app, "/allocate", {
      runId: "run_no_org",
      projectId: "proj",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });
    expect(response.status).toBe(400);
    expect(store.records).toHaveLength(0);
  });

  it("allocates and releases successfully", async () => {
    const { app, docker, store } = buildApp();

    const allocated = await postJson(app, "/allocate", {
      runId: "run_api",
      projectId: "proj",
      orgId: "org_api",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    });
    expect(allocated.status).toBe(201);
    const allocatedBody = (await allocated.json()) as { runnerId: string };
    expect(allocatedBody.runnerId).toBe("runner_run_api");
    // De-priv: the run's org reaches the store so the `runners` row can be
    // written under that org's RLS scope.
    expect(store.records[0]?.orgId).toBe("org_api");

    const released = await postJson(app, "/release", {
      runnerId: allocatedBody.runnerId,
      reason: "completed",
    });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ released: true });
    expect(docker.containers[0]?.removed).toBe(true);
    expect(store.records[0]?.released).toBe(true);
  });

  it("accepts a runless allocate and persists NULL run_id with the given project_id", async () => {
    const { app, store } = buildApp();

    const allocated = await postJson(app, "/allocate", {
      // Synthetic Forge ideation handle — NOT a real run; runless marks it so.
      runId: "forge_org_api_abcd1234",
      projectId: "proj-handle",
      orgId: "org_api",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      runless: true,
      persistedProjectId: "proj_real",
    });
    expect(allocated.status).toBe(201);
    // The persisted runners row has NULL run_id (no `runs` row) and the REAL
    // project_id from `persistedProjectId` — never the synthetic handle.
    expect(store.records[0]?.runId).toBeNull();
    expect(store.records[0]?.projectId).toBe("proj_real");
    expect(store.records[0]?.orgId).toBe("org_api");
  });

  it("/release on an unknown runner returns released: false", async () => {
    const { app } = buildApp();
    const response = await postJson(app, "/release", {
      runnerId: "runner_missing",
      reason: "completed",
    });
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
