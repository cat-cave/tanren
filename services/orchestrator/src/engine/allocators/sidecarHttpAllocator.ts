import { readFileSync } from "node:fs";
import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

/**
 * Resolve the sidecar bearer token, FILE-PREFERRED (Codex r5): prod mounts it as
 * `/run/secrets/tanren_allocator_token` and sets `TANREN_ALLOCATOR_TOKEN_FILE`, so the
 * token VALUE never lands in Docker env / `docker inspect`; dev sets the plaintext
 * `TANREN_ALLOCATOR_TOKEN`. The file WINS; a configured-but-empty/unreadable file is a
 * HARD failure (never a silent blank token), as is a missing token altogether. Lives
 * here (not buildAllocator) so the orchestrator-side allocator factory does not take a
 * new fs dependency. Reads `process.env` (injectable for tests).
 */
export function resolveSidecarAuthToken(env: Record<string, string | undefined> = process.env): string {
  const filePath = env["TANREN_ALLOCATOR_TOKEN_FILE"];
  if (filePath !== undefined && filePath !== "") {
    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch (cause) {
      throw new Error(`TANREN_ALLOCATOR_TOKEN_FILE=${filePath} could not be read`, { cause });
    }
    const value = contents.trim();
    if (value === "") {
      throw new Error(
        `TANREN_ALLOCATOR_TOKEN_FILE=${filePath} is empty (no allocator bearer token in the mounted file)`,
      );
    }
    return value;
  }
  const envValue = env["TANREN_ALLOCATOR_TOKEN"];
  if (envValue === undefined || envValue === "") {
    throw new Error("TANREN_ALLOCATOR_TOKEN is required (set it in the environment; there is no default)");
  }
  return envValue;
}

export interface SidecarHttpAllocatorOptions {
  /** Base URL of the allocator sidecar, e.g. `http://allocator:3200`. */
  baseUrl: string;
  /** Bearer token shared with the allocator sidecar. */
  authToken: string;
  /** Username the SSH substrate authenticates with. */
  sshUsername?: string;
  /** Stores release bookkeeping for the sidecar-owned runners row. */
  runners: RunnerStore;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface SidecarAllocateResponse {
  runnerId: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
}

interface SidecarReleaseResponse {
  released: boolean;
}

/**
 * Orchestrator-side allocator client. The orchestrator container no longer has
 * Docker socket access; instead it calls the allocator sidecar over
 * HTTP. The sidecar owns container lifecycle and finalizer cleanup.
 */
export class SidecarHttpAllocator implements Allocator {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SidecarHttpAllocatorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    // SYSTEM-vs-USERLAND credential split: NO secret ref or VALUE is ever sent to
    // the sidecar. The allocator only creates/destroys containers + persists the
    // `runners` row; it has no secret-store access and delivers no secret to a
    // runner via Docker env. `identitySecretRef` (the orchestrator's own SSH
    // private key, how Tanren reaches the runner) belongs ONLY in the returned
    // `target` handle, which the orchestrator's SSH substrate resolves to open the
    // connection. Run-scoped runner creds (the tenant's model/codex auth) are
    // delivered over the SSH FILE substrate AFTER allocation (codexMaterializer /
    // opencodeMaterializer).
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, "")}/allocate`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        // runId/projectId are the runner's naming HANDLE (container + volume
        // names). For a runless Forge ideation allocation the service persists its
        // runners row's run_id as NULL and project_id as `persistedProjectId`
        // (NULL or the real project) — it keys off `runless`, not off these being
        // absent, so naming stays stable while the FK columns stay FK-safe.
        runId: request.runId,
        projectId: request.projectId,
        runnerImage: request.runnerImage,
        orgId: request.orgId,
        ...(request.runless === true
          ? { runless: true, persistedProjectId: persistedRunnerKeys(request).projectId }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`allocator sidecar /allocate failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as SidecarAllocateResponse;
    const allocation: RunnerAllocation = {
      runnerId: body.runnerId,
      imageSha: body.imageSha,
      target: sshRunnerHandle({
        host: body.sshHost,
        port: body.sshPort,
        username: this.options.sshUsername ?? "tanren",
        hostKeyFingerprint: body.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
      }),
    };

    return allocation;
  }

  async release(runnerId: string, reason: ReleaseReason = "completed"): Promise<void> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/u, "")}/release`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ runnerId, reason }),
    });
    if (!response.ok) {
      throw new Error(`allocator sidecar /release failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as SidecarReleaseResponse;
    if (body.released) {
      await this.options.runners.release(runnerId);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      authorization: `Bearer ${this.options.authToken}`,
    };
  }
}
