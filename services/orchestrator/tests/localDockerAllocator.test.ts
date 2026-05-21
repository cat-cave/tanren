import { describe, expect, it } from "vitest";
import type { AllocationRequest } from "../src/engine/contracts/allocator.js";
import type { DockerClient, DockerContainer } from "../src/engine/allocators/dockerClient.js";
import { LocalDockerAllocator } from "../src/engine/allocators/localDockerAllocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";
import { sshSha256Fingerprint } from "../src/engine/ssh/fingerprint.js";

const request: AllocationRequest = {
  runId: "run_1",
  projectId: "project_1",
  runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
  identitySecretRef: "runner/run_1/identity"
};

const container: DockerContainer = {
  id: "container_1",
  imageSha: "sha256:runner-image",
  labels: {},
  env: {},
  running: true
};

describe("local Docker allocator", () => {
  it("claims the compose runner, stores metadata, and returns an SSH target", async () => {
    const docker = new FakeDockerClient(container);
    const runners = new FakeRunnerStore();
    const allocator = new LocalDockerAllocator({
      docker,
      runners,
      hostKeyFingerprint: "SHA256:runner-host-key"
    });

    const allocation = await allocator.allocate(request);

    expect(docker.requestedServiceName).toBe("runner");
    expect(allocation).toEqual({
      runnerId: "runner_run_1",
      imageSha: "sha256:runner-image",
      target: {
        host: "runner",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:runner-host-key",
        identitySecretRef: "runner/run_1/identity"
      }
    });
    expect(runners.claims).toEqual([
      {
        runnerId: "runner_run_1",
        runId: "run_1",
        projectId: "project_1",
        allocator: "local-docker",
        sshHost: "runner",
        sshPort: 22,
        hostKeyFingerprint: "SHA256:runner-host-key",
        imageSha: "sha256:runner-image",
        containerId: "container_1"
      }
    ]);
  });

  it("uses request identitySecretRef and runner metadata labels", async () => {
    const docker = new FakeDockerClient({
      ...container,
      labels: {
        "tanren.ssh.host": "custom-runner",
        "tanren.ssh.port": "2200",
        "tanren.ssh.username": "runner-user",
        "tanren.ssh.host_key_fingerprint": "SHA256:label-host-key"
      }
    });
    const allocator = new LocalDockerAllocator({ docker, runners: new FakeRunnerStore() });

    const allocation = await allocator.allocate({ ...request, identitySecretRef: "secret/custom-key" });

    expect(allocation.target).toEqual({
      host: "custom-runner",
      port: 2200,
      username: "runner-user",
      hostKeyFingerprint: "SHA256:label-host-key",
      identitySecretRef: "secret/custom-key"
    });
  });

  it("derives the SSH host key fingerprint from the runner public key", async () => {
    const keyBlob = Buffer.from("tanren-runner-host-key");
    const publicKey = Buffer.from(`ssh-ed25519 ${keyBlob.toString("base64")} runner\n`);
    const allocator = new LocalDockerAllocator({
      docker: new FakeDockerClient(container, publicKey),
      runners: new FakeRunnerStore()
    });

    const allocation = await allocator.allocate(request);

    expect(allocation.target.hostKeyFingerprint).toBe(sshSha256Fingerprint(keyBlob));
  });

  it("marks the runner released without stopping the compose runner", async () => {
    const runners = new FakeRunnerStore();
    const allocator = new LocalDockerAllocator({
      docker: new FakeDockerClient(container),
      runners,
      hostKeyFingerprint: "SHA256:runner-host-key"
    });

    await allocator.release("runner_run_1");

    expect(runners.releases).toEqual(["runner_run_1"]);
  });

  it("fails clearly when the compose runner is missing", async () => {
    const allocator = new LocalDockerAllocator({
      docker: new FakeDockerClient(undefined),
      runners: new FakeRunnerStore(),
      hostKeyFingerprint: "SHA256:runner-host-key"
    });

    await expect(allocator.allocate(request)).rejects.toThrow('local Docker runner service "runner" was not found');
  });

  it("fails clearly when the compose runner is stopped", async () => {
    const allocator = new LocalDockerAllocator({
      docker: new FakeDockerClient({ ...container, running: false }),
      runners: new FakeRunnerStore(),
      hostKeyFingerprint: "SHA256:runner-host-key"
    });

    await expect(allocator.allocate(request)).rejects.toThrow('local Docker runner service "runner" is not running');
  });
});

class FakeDockerClient implements DockerClient {
  requestedServiceName?: string;

  constructor(
    private readonly dockerContainer: DockerContainer | undefined,
    private readonly file = Buffer.from("")
  ) {}

  async findComposeServiceContainer(serviceName: string): Promise<DockerContainer | undefined> {
    this.requestedServiceName = serviceName;
    return this.dockerContainer;
  }

  async readContainerFile(): Promise<Buffer> {
    return this.file;
  }
}

class FakeRunnerStore implements RunnerStore {
  readonly claims: ClaimRunnerInput[] = [];
  readonly releases: string[] = [];

  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claims.push(input);
  }

  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}
