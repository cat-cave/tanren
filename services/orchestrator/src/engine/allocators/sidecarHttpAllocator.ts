import {
  persistedRunnerKeys,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "sidecar-docker";

export interface SidecarHttpAllocatorOptions {
  /** Base URL of the allocator sidecar, e.g. `http://allocator:3200`. */
  baseUrl: string;
  /** Bearer token shared with the allocator sidecar. */
  authToken: string;
  /** Username the SSH substrate authenticates with. */
  sshUsername?: string;
  /** Stores the runners table row mirror for orchestrator-side bookkeeping. */
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
 * Docker socket access (P2A-0010); instead it calls the allocator sidecar over
 * HTTP. The sidecar owns container lifecycle and finalizer cleanup.
 */
export class SidecarHttpAllocator implements Allocator {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SidecarHttpAllocatorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const vaultRefs = uniqueRefs([request.identitySecretRef, ...(request.vaultRefs ?? [])]);
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
        vaultRefs,
      }),
    });
    if (!response.ok) {
      throw new Error(`allocator sidecar /allocate failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as SidecarAllocateResponse;
    const allocation: RunnerAllocation = {
      runnerId: body.runnerId,
      imageSha: body.imageSha,
      target: {
        host: body.sshHost,
        port: body.sshPort,
        username: this.options.sshUsername ?? "tanren",
        hostKeyFingerprint: body.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
      },
    };

    // Sidecar already persisted its own row for ownership; the orchestrator
    // mirror is kept idempotent so existing workflow code that reads from
    // `runners` continues to find the row.
    await this.options.runners.claim({
      runnerId: allocation.runnerId,
      // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
      // ideation allocation whose synthetic handle is not a real run/project.
      ...persistedRunnerKeys(request),
      orgId: request.orgId ?? null,
      allocator: allocatorName,
      sshHost: allocation.target.host,
      sshPort: allocation.target.port,
      hostKeyFingerprint: allocation.target.hostKeyFingerprint,
      imageSha: allocation.imageSha,
      containerId: allocation.runnerId,
    });

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

function uniqueRefs(refs: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref !== undefined && ref !== "" && !seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}
