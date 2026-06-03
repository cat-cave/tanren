import type { AllocationRequest, Allocator, ReleaseReason, RunnerAllocation } from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "manual-ssh";

/**
 * A single pre-provisioned SSH host in the manual pool. Hosts are long-lived,
 * operator-managed machines; the allocator never creates or destroys them. The
 * identity used to authenticate is a Vault ref so private keys never live in
 * config.
 */
export interface ManualSshHost {
  /** Stable identifier used for the runner id and capacity bookkeeping. */
  id: string;
  host: string;
  port?: number;
  username?: string;
  /** Pre-known SHA256 host key fingerprint (manual hosts have stable keys). */
  hostKeyFingerprint: string;
  /** Vault ref for the SSH private key. Falls back to the request identity. */
  identitySecretRef?: string;
}

export interface ManualSshAllocatorOptions {
  /** The configured pool of pre-provisioned hosts. Must be non-empty. */
  hosts: ReadonlyArray<ManualSshHost>;
  /** Default SSH username when a host omits one. */
  defaultUsername?: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
}

/**
 * Allocates a runner onto one of a fixed set of pre-provisioned SSH hosts. No
 * cloud API is involved: the operator provisions the machines out of band and
 * lists them in config (host / port / user / fingerprint / key ref). The
 * allocator round-robins across free hosts, claims one for the duration of the
 * run, and frees it on release. If every host is busy, allocation fails fast so
 * the pool-policy layer above can surface a capacity error rather than silently
 * double-booking a machine.
 */
export class ManualSshAllocator implements Allocator {
  private readonly hosts: ReadonlyArray<ManualSshHost>;
  /** runnerId -> hostId, so release frees the right host. */
  private readonly leases = new Map<string, string>();
  /** hostIds currently leased. */
  private readonly busy = new Set<string>();

  constructor(private readonly options: ManualSshAllocatorOptions) {
    if (options.hosts.length === 0) {
      throw new Error("ManualSshAllocator requires at least one configured host");
    }
    this.hosts = options.hosts;
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const host = this.hosts.find((candidate) => !this.busy.has(candidate.id));
    if (host === undefined) {
      throw new Error(`manual-ssh pool exhausted: all ${this.hosts.length} hosts are leased (run ${request.runId})`);
    }

    const port = host.port ?? 22;
    const username = host.username ?? this.options.defaultUsername ?? "tanren";
    const identitySecretRef = host.identitySecretRef ?? request.identitySecretRef;
    const runnerId = `runner_${request.runId}`;

    this.busy.add(host.id);
    this.leases.set(runnerId, host.id);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:manual-ssh`,
      target: {
        host: host.host,
        port,
        username,
        hostKeyFingerprint: host.hostKeyFingerprint,
        identitySecretRef,
      },
    };

    try {
      await this.options.runners.claim({
        runnerId,
        runId: request.runId,
        projectId: request.projectId,
        orgId: request.orgId ?? null,
        allocator: allocatorName,
        sshHost: host.host,
        sshPort: port,
        hostKeyFingerprint: host.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: host.id,
      });
    } catch (error) {
      // Don't leak the lease if the mirror write fails.
      this.busy.delete(host.id);
      this.leases.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const hostId = this.leases.get(runnerId);
    if (hostId === undefined) {
      // Already released or never allocated by this instance: no-op.
      return;
    }
    this.leases.delete(runnerId);
    this.busy.delete(hostId);
    // Manual hosts are long-lived; we never destroy them, only free the lease
    // and clear the orchestrator mirror row.
    await this.options.runners.release(runnerId);
  }
}
