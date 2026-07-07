import { z } from "zod";
import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type AllocatorTaxonomy,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "manual-ssh";

// Strict decode of the manual-hosts JSON (Codex r4 §2). The old `JSON.parse(raw) as
// ManualSshHost[]` in buildAllocator was a TRUSTED CAST: a bad host shape / blank
// id-host-or-fingerprint / out-of-range port passed construction and only blew up
// LATER during allocation/SSH (a cryptic mid-run failure on a misconfigured operator
// value). This schema fails LOUD at construction — non-empty array; non-empty
// `id`/`host`/`hostKeyFingerprint`; a TCP port in range when present; optional refs
// non-empty when present. `.strict()` rejects stray keys so a typo'd field surfaces.
const manualSshHostSchema: z.ZodType<ManualSshHost> = z
  .object({
    id: z.string().trim().min(1, "manual-ssh host id must be non-empty"),
    host: z.string().trim().min(1, "manual-ssh host must be non-empty"),
    port: z.number().int().min(1).max(65_535).optional(),
    username: z.string().trim().min(1).optional(),
    hostKeyFingerprint: z.string().trim().min(1, "manual-ssh hostKeyFingerprint must be non-empty"),
    identitySecretRef: z.string().trim().min(1).optional(),
  })
  .strict();
const manualSshHostsSchema = z.array(manualSshHostSchema).min(1, "manual_ssh allocator requires at least one host");

/**
 * Parse + strictly validate the `TANREN_MANUAL_SSH_HOSTS` JSON. Throws LOUD on
 * non-JSON or any malformed/blank-field/bad-port host (Codex r4 §2) so a
 * misconfigured manual pool fails at construction, not mid-allocation.
 */
export function parseManualSshHosts(raw: string): ManualSshHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("TANREN_MANUAL_SSH_HOSTS is not valid JSON (expected a JSON array of hosts)", { cause });
  }
  const result = manualSshHostsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`TANREN_MANUAL_SSH_HOSTS is malformed (fail-loud at construction):\n${issues}`);
  }
  return result.data;
}

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
  // FIXED-POOL: pre-provisioned, operator-managed hosts. `allocate()` leases one;
  // `release()` frees the lease + clears the mirror row. The hosts are never
  // created or destroyed by the allocator.
  readonly taxonomy: AllocatorTaxonomy = "fixed_pool";
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
      target: sshRunnerHandle({
        host: host.host,
        port,
        username,
        hostKeyFingerprint: host.hostKeyFingerprint,
        identitySecretRef,
      }),
    };

    try {
      await this.options.runners.claim({
        runnerId,
        // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
        // ideation allocation whose synthetic handle is not a real run/project.
        ...persistedRunnerKeys(request),
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
