import { createHash } from "node:crypto";
import type { DockerEngineClient } from "./dockerEngine.js";

export interface RunnerSecretsClient {
  /** Returns the secret value for a Vault ref, or undefined when missing. */
  get(ref: string): Promise<string | undefined>;
}

export interface RunnerRecord {
  runnerId: string;
  runId: string;
  projectId: string;
  containerId: string;
  workspaceVolume: string;
  codexHomeVolume: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
  vaultRefs: string[];
  createdAt: Date;
  released: boolean;
}

export interface RunnerStore {
  insert(record: RunnerRecord): Promise<void>;
  markReleased(runnerId: string, reason: string): Promise<RunnerRecord | undefined>;
  findActive(runnerId: string): Promise<RunnerRecord | undefined>;
  listActiveOlderThan(threshold: Date): Promise<RunnerRecord[]>;
}

export interface AllocateInput {
  runId: string;
  projectId: string;
  runnerImage: string;
  vaultRefs: string[];
}

export interface AllocateResult {
  runnerId: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
}

export interface RunnerLifecycleConfig {
  docker: DockerEngineClient;
  store: RunnerStore;
  secrets: RunnerSecretsClient;
  /** Internal docker network name the allocator attaches each runner to. */
  networkName: string;
  /** When set (dev profile), publishes the runner SSH port on the host. */
  hostSshPort?: number;
  /** Host the orchestrator should SSH to. In prod this is the container DNS name. */
  sshHostnameForOrchestrator: (containerName: string) => string;
  /** Max number of polls when waiting for sshd host key. */
  hostKeyReadAttempts?: number;
  hostKeyReadDelayMs?: number;
  /** Backoff utility (overridable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra docker capabilities the runner needs (e.g. SYS_ADMIN for codex sandbox). */
  capAdd?: string[];
  securityOpt?: string[];
  /** Optional clock for testing. */
  now?: () => Date;
}

export class RunnerLifecycle {
  private readonly docker: DockerEngineClient;
  private readonly store: RunnerStore;
  private readonly secrets: RunnerSecretsClient;
  private readonly networkName: string;
  private readonly hostSshPort: number | undefined;
  private readonly hostnameForOrchestrator: (containerName: string) => string;
  private readonly hostKeyReadAttempts: number;
  private readonly hostKeyReadDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly capAdd: string[];
  private readonly securityOpt: string[];
  private readonly clock: () => Date;

  constructor(config: RunnerLifecycleConfig) {
    this.docker = config.docker;
    this.store = config.store;
    this.secrets = config.secrets;
    this.networkName = config.networkName;
    this.hostSshPort = config.hostSshPort;
    this.hostnameForOrchestrator = config.sshHostnameForOrchestrator;
    this.hostKeyReadAttempts = config.hostKeyReadAttempts ?? 30;
    this.hostKeyReadDelayMs = config.hostKeyReadDelayMs ?? 500;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.capAdd = config.capAdd ?? [];
    this.securityOpt = config.securityOpt ?? [];
    this.clock = config.now ?? (() => new Date());
  }

  async allocate(input: AllocateInput): Promise<AllocateResult> {
    const runnerId = `runner_${input.runId}`;
    const slug = `tanren-runner-${input.runId}`.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
    const containerName = slug;
    const workspaceVolume = volumeNamesFor(input.runId).workspace;
    const codexHomeVolume = volumeNamesFor(input.runId).codexHome;
    const codexHomeBundle = await this.materializeCodexHome(input.vaultRefs);

    await this.docker.createVolume(workspaceVolume, allocatorLabels(input.runId));
    await this.docker.createVolume(codexHomeVolume, allocatorLabels(input.runId));

    const containerId = await this.docker.createContainer({
      name: containerName,
      image: input.runnerImage,
      env: {
        TANREN_RUNNER_AUTHORIZED_KEY: process.env["TANREN_RUNNER_AUTHORIZED_KEY"] ?? "",
        TANREN_CODEX_HOME_BUNDLE: codexHomeBundle,
        TANREN_RUNNER_EPHEMERAL: "1",
      },
      labels: allocatorLabels(input.runId),
      volumes: [
        { volumeName: workspaceVolume, containerPath: "/workspace" },
        { volumeName: codexHomeVolume, containerPath: "/tanren-runtime/codex-home" },
      ],
      networkName: this.networkName,
      hostSshPort: this.hostSshPort,
      capAdd: this.capAdd,
      securityOpt: this.securityOpt,
    });
    await this.docker.startContainer(containerId);
    const inspected = await this.docker.inspectContainer(containerId);
    const hostKeyFingerprint = await this.readHostKeyFingerprint(containerId);

    const sshHost = this.hostnameForOrchestrator(containerName);
    const sshPort = this.hostSshPort ?? 22;

    const record: RunnerRecord = {
      runnerId,
      runId: input.runId,
      projectId: input.projectId,
      containerId,
      workspaceVolume,
      codexHomeVolume,
      sshHost,
      sshPort,
      hostKeyFingerprint,
      imageSha: inspected.imageSha,
      vaultRefs: input.vaultRefs,
      createdAt: this.clock(),
      released: false,
    };
    await this.store.insert(record);

    return {
      runnerId,
      sshHost,
      sshPort,
      hostKeyFingerprint,
      imageSha: inspected.imageSha,
    };
  }

  async release(runnerId: string, reason: string): Promise<{ released: boolean }> {
    const record = await this.store.findActive(runnerId);
    if (record === undefined) {
      return { released: false };
    }
    await this.docker.stopContainer(record.containerId);
    await this.docker.removeContainer(record.containerId, true);
    // Workspace + CODEX_HOME volumes are wiped on every release path (success
    // or failure). This is the security boundary the spec calls out: nothing
    // from the previous run survives.
    await this.docker.removeVolume(record.workspaceVolume);
    await this.docker.removeVolume(record.codexHomeVolume);
    await this.store.markReleased(runnerId, reason);
    return { released: true };
  }

  async sweepAbandoned(maxAgeMs: number): Promise<RunnerRecord[]> {
    const threshold = new Date(this.clock().getTime() - maxAgeMs);
    const candidates = await this.store.listActiveOlderThan(threshold);
    const reclaimed: RunnerRecord[] = [];
    for (const candidate of candidates) {
      const result = await this.release(candidate.runnerId, "abandoned");
      if (result.released) {
        reclaimed.push(candidate);
      }
    }
    return reclaimed;
  }

  private async materializeCodexHome(vaultRefs: string[]): Promise<string> {
    if (vaultRefs.length === 0) {
      return "";
    }
    const files: Array<{ ref: string; value: string }> = [];
    for (const ref of vaultRefs) {
      const value = await this.secrets.get(ref);
      if (value === undefined) {
        throw new Error(`vault ref ${ref} did not resolve to a secret value`);
      }
      files.push({ ref, value });
    }
    return Buffer.from(JSON.stringify(files)).toString("base64");
  }

  private async readHostKeyFingerprint(containerId: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.hostKeyReadAttempts; attempt += 1) {
      try {
        const publicKey = await this.docker.readContainerFile(containerId, "/etc/ssh/ssh_host_ed25519_key.pub");
        const fingerprint = fingerprintOpenSshPublicKey(publicKey);
        if (fingerprint !== undefined) {
          return fingerprint;
        }
      } catch (error) {
        lastError = error;
      }
      await this.sleep(this.hostKeyReadDelayMs);
    }
    throw new Error(
      `runner container ${containerId} did not expose an SSH host key in time${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
  }
}

export function volumeNamesFor(runId: string): { workspace: string; codexHome: string } {
  const slug = `tanren-runner-${runId}`.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
  return {
    workspace: `${slug}-workspace`,
    codexHome: `${slug}-codex-home`,
  };
}

export function allocatorLabels(runId: string): Record<string, string> {
  return {
    "tanren.managed-by": "allocator",
    "tanren.run-id": runId,
  };
}

export function fingerprintOpenSshPublicKey(publicKey: Buffer): string | undefined {
  const [, encodedKey] = publicKey.toString("utf8").trim().split(/\s+/u);
  if (encodedKey === undefined || encodedKey === "") {
    return undefined;
  }
  const keyBuffer = Buffer.from(encodedKey, "base64");
  return `SHA256:${createHash("sha256").update(keyBuffer).digest("base64").replace(/=+$/u, "")}`;
}
