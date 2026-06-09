import { createHash } from "node:crypto";
import type { DockerEngineClient } from "./dockerEngine.js";

export interface RunnerRecord {
  runnerId: string;
  /**
   * The value persisted to `runners.run_id` (FK → `runs`). `null` for a RUNLESS
   * Forge ideation allocation, whose synthetic handle is not a real `runs` row.
   * The runner NAMING handle is carried separately in {@link RunnerRecord.handle};
   * this field is only the DB column value (and is read back as `null`).
   */
  runId: string | null;
  /** The value persisted to `runners.project_id` (FK → `projects`); `null` when runless / project-less. */
  projectId: string | null;
  /**
   * The stable NAMING handle used to derive the runner id, container name, and
   * volume names. Always present (a synthetic `forge_<…>` id when runless). NOT a
   * DB column — recomputed from inputs / `container_id` on read.
   */
  handle: string;
  /** The org the run belongs to; the `runners` row is written under its RLS scope. */
  orgId: string;
  containerId: string;
  workspaceVolume: string;
  codexHomeVolume: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
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
  /** The org the run belongs to; the runner row is persisted under its RLS scope. */
  orgId: string;
  /**
   * RUNLESS Forge ideation marker. When true, `runId` / `projectId` are a stable
   * synthetic naming HANDLE (still used for the runner id, container, and volume
   * names) but the persisted runners row's run_id column is NULL — the handle is
   * not a real `runs` row, so persisting it would violate the run_id→runs FK.
   */
  runless?: boolean;
  /**
   * The value to persist to project_id when {@link runless}: the REAL project id
   * for a project-scoped Forge surface, or `null` for the project-less greenfield
   * interview. Ignored when `runless` is false (the run path persists `projectId`).
   */
  persistedProjectId?: string | null;
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
    this.networkName = config.networkName;
    this.hostSshPort = config.hostSshPort;
    this.hostnameForOrchestrator = config.sshHostnameForOrchestrator;
    this.hostKeyReadAttempts = config.hostKeyReadAttempts ?? 30;
    this.hostKeyReadDelayMs = config.hostKeyReadDelayMs ?? 500;
    this.sleep =
      config.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
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

    // Idempotent allocate (fix #3): the runner id is the deterministic
    // `runner_<handle>`, so a RETRIED /allocate for the same handle would, with a
    // bare `ON CONFLICT DO UPDATE`, overwrite a still-LIVE container_id —
    // orphaning the prior container (unreferenced → unsweepable, the 204GB-leak
    // class). Pre-check for a live row and return its SSH target unchanged.
    // Never create a second container for an already-allocated runner.
    const existing = await this.store.findActive(runnerId);
    if (existing !== undefined) {
      return {
        runnerId: existing.runnerId,
        sshHost: existing.sshHost,
        sshPort: existing.sshPort,
        hostKeyFingerprint: existing.hostKeyFingerprint,
        imageSha: existing.imageSha,
      };
    }

    // Side-effect chain (fix #1): every step below is a Docker/DB side effect
    // that can throw — createContainer, startContainer, inspectContainer,
    // readHostKeyFingerprint (throws on retry-exhaustion), store.insert (throws
    // on a DB outage). A throw after the first createVolume would orphan the two
    // volumes + the container, INVISIBLE to release/sweepAbandoned (which key off
    // the DB row that was never written). Wrap the whole chain and tear the
    // partial state down best-effort by deterministic name before re-throwing.
    await this.docker.createVolume(workspaceVolume, allocatorLabels(input.runId));
    await this.docker.createVolume(codexHomeVolume, allocatorLabels(input.runId));

    try {
      const containerId = await this.docker.createContainer({
        name: containerName,
        image: input.runnerImage,
        // No secret VALUE is ever delivered to a runner via Docker env. The only
        // env here is the PUBLIC authorized_keys line (safe) + the ephemeral
        // marker. Run-scoped runner credentials (the tenant's model/codex auth) are
        // written into CODEX_HOME over the SSH FILE substrate AFTER allocation
        // (orchestrator codexMaterializer / opencodeMaterializer), so `docker
        // inspect` on a runner can carry no secret.
        env: {
          TANREN_RUNNER_AUTHORIZED_KEY: process.env["TANREN_RUNNER_AUTHORIZED_KEY"] ?? "",
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

      try {
        await this.docker.startContainer(containerId);
        const inspected = await this.docker.inspectContainer(containerId);
        const hostKeyFingerprint = await this.readHostKeyFingerprint(containerId);

        const sshHost = this.hostnameForOrchestrator(containerName);
        const sshPort = this.hostSshPort ?? 22;

        const record: RunnerRecord = {
          runnerId,
          // Runless Forge ideation: run_id is NULL (no `runs` row); project_id is the
          // caller's `persistedProjectId` (the real project, or null when project-less)
          // — never the synthetic handle. The handle is kept in `handle` for
          // naming/recovery only.
          runId: input.runless === true ? null : input.runId,
          projectId: input.runless === true ? (input.persistedProjectId ?? null) : input.projectId,
          handle: input.runId,
          orgId: input.orgId,
          containerId,
          workspaceVolume,
          codexHomeVolume,
          sshHost,
          sshPort,
          hostKeyFingerprint,
          imageSha: inspected.imageSha,
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
      } catch (error) {
        // The container exists but a later step failed: remove it before falling
        // through to the volume teardown below.
        await this.docker.removeContainer(containerId, true).catch(() => {});
        throw error;
      }
    } catch (error) {
      // Best-effort teardown of the orphaned volumes (the container, if any, was
      // already removed in the inner catch). Each teardown swallows its own
      // failure so it can never MASK the original error — the original is always
      // re-thrown (fail-closed + loud at the caller).
      await this.docker.removeVolume(workspaceVolume).catch(() => {});
      await this.docker.removeVolume(codexHomeVolume).catch(() => {});
      throw error;
    }
  }

  async release(runnerId: string, reason: string): Promise<{ released: boolean }> {
    // markReleased is the SINGLE atomic CLAIM gate (fix #2). It flips the row to
    // released only when it was still active (`AND released_at IS NULL` in the
    // UPDATE), returning the claimed record on rowCount===1 and `undefined` when
    // some other caller already released it. We gate ALL Docker teardown on
    // winning the claim, so two concurrent release() calls tear the same
    // container+volumes down EXACTLY once. The loser is a clean no-op.
    const record = await this.store.markReleased(runnerId, reason);
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
