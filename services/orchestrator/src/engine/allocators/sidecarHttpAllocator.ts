import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

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
    // SYSTEM-vs-USERLAND credential split: `identitySecretRef` is the
    // ORCHESTRATOR's SSH private key (how Tanren reaches the runner). It MUST NOT
    // be sent to the sidecar — the sidecar materializes every supplied ref's
    // VALUE into the runner's CODEX_HOME Docker env bundle, which would land the
    // orchestrator's private key inside runner container state. It belongs ONLY
    // in the returned `target` handle, which the orchestrator's own SSH substrate
    // resolves to open the connection. Run-scoped runner creds (the tenant's
    // model/codex auth) are delivered over the SSH FILE substrate AFTER
    // allocation (see codexMaterializer / opencodeMaterializer), never as Docker
    // env. So only any caller-supplied `vaultRefs` (today: none on the live
    // path) flow to the sidecar — and the identity ref is defensively stripped
    // even if a caller redundantly threaded it into `vaultRefs`.
    const vaultRefs = uniqueRefs(request.vaultRefs ?? []).filter((ref) => ref !== request.identitySecretRef);
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
