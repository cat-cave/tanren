import type { AllocationRequest, Allocator, RunnerAllocation, SshTarget } from "../contracts/allocator.js";
import { sshSha256Fingerprint } from "../ssh/fingerprint.js";
import type { DockerClient, DockerContainer } from "./dockerClient.js";
import { DockerEngineClient } from "./dockerClient.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "local-docker";

export interface LocalDockerAllocatorOptions {
  docker?: DockerClient;
  runners: RunnerStore;
  runnerServiceName?: string;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  hostKeyFingerprint?: string;
}

export class LocalDockerAllocator implements Allocator {
  private readonly docker: DockerClient;
  private readonly runnerServiceName: string;

  constructor(private readonly options: LocalDockerAllocatorOptions) {
    this.docker = options.docker ?? new DockerEngineClient();
    this.runnerServiceName = options.runnerServiceName ?? "runner";
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const container = await this.docker.findComposeServiceContainer(this.runnerServiceName);
    if (container === undefined) {
      throw new Error(`local Docker runner service "${this.runnerServiceName}" was not found`);
    }
    if (!container.running) {
      throw new Error(`local Docker runner service "${this.runnerServiceName}" is not running`);
    }

    const target = await this.targetFor(container, request.identitySecretRef);
    const runnerId = `runner_${request.runId}`;
    await this.options.runners.claim({
      runnerId,
      runId: request.runId,
      projectId: request.projectId,
      allocator: allocatorName,
      sshHost: target.host,
      sshPort: target.port,
      hostKeyFingerprint: target.hostKeyFingerprint,
      imageSha: container.imageSha,
      containerId: container.id
    });

    return {
      runnerId,
      target,
      imageSha: container.imageSha
    };
  }

  async release(runnerId: string): Promise<void> {
    await this.options.runners.release(runnerId);
  }

  private async targetFor(container: DockerContainer, identitySecretRef: string): Promise<SshTarget> {
    const hostKeyFingerprint = await this.hostKeyFingerprintFor(container);
    if (hostKeyFingerprint === undefined || hostKeyFingerprint === "") {
      throw new Error(
        `local Docker runner service "${this.runnerServiceName}" is missing a host key fingerprint; set TANREN_RUNNER_HOST_KEY_FINGERPRINT`
      );
    }

    return {
      host: this.options.sshHost ?? container.labels["tanren.ssh.host"] ?? "runner",
      port: this.options.sshPort ?? Number(container.labels["tanren.ssh.port"] ?? 22),
      username: this.options.sshUsername ?? container.labels["tanren.ssh.username"] ?? "tanren",
      hostKeyFingerprint,
      identitySecretRef
    };
  }

  private async hostKeyFingerprintFor(container: DockerContainer): Promise<string | undefined> {
    const configuredFingerprint =
      this.options.hostKeyFingerprint ??
      container.labels["tanren.ssh.host_key_fingerprint"] ??
      container.env.TANREN_RUNNER_HOST_KEY_FINGERPRINT ??
      process.env.TANREN_RUNNER_HOST_KEY_FINGERPRINT;

    if (configuredFingerprint !== undefined) {
      return configuredFingerprint;
    }

    const publicKey = await this.docker.readContainerFile(container.id, "/etc/ssh/ssh_host_ed25519_key.pub");
    return fingerprintOpenSshPublicKey(publicKey);
  }
}

function fingerprintOpenSshPublicKey(publicKey: Buffer): string | undefined {
  const [, encodedKey] = publicKey.toString("utf8").trim().split(/\s+/u);
  if (encodedKey === undefined || encodedKey === "") {
    return undefined;
  }
  return sshSha256Fingerprint(Buffer.from(encodedKey, "base64"));
}
