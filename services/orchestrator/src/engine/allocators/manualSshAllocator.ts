import { randomUUID } from "node:crypto";
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
import type { PoolLeaseCandidate, RunnerPoolLeaseStore } from "./runnerStore.js";

const allocatorName = "manual-ssh";
/** The pool-cap bucket key for manual-ssh leases (see `runners.pool_key`). */
const manualSshPoolKey = "manual_ssh";

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
  /**
   * Shared-store lease seam (#1254). Host busy-tracking + the `maxConcurrent` cap
   * live on the `runners` table so they coordinate across orchestrator processes,
   * replacing the pre-#1254 in-memory per-process maps that double-booked hosts.
   */
  leases: RunnerPoolLeaseStore;
  /**
   * Cross-process cap from the routing pool policy (`pools.manual_ssh.maxConcurrent`).
   * Enforced atomically in {@link RunnerPoolLeaseStore.reservePoolLease}; undefined ⇒
   * bounded only by the configured host count.
   */
  maxConcurrent?: number;
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
  // `release()` frees the lease. The hosts are never created or destroyed here.
  readonly taxonomy: AllocatorTaxonomy = "fixed_pool";
  // The cap + host busy-tracking are enforced in the SHARED store, so the router
  // delegates its (per-process) cap to this allocator's cross-process reservation.
  readonly enforcesOwnPoolCap = true as const;
  private readonly hosts: ReadonlyArray<ManualSshHost>;
  /** This allocator instance's fencing owner — distinct per process/instance (#1254). */
  private readonly leaseOwner = `manual_ssh:${randomUUID()}`;
  /** runnerId -> the fencing token this instance holds, so its own release is owner-checked. */
  private readonly held = new Map<string, { fencingToken: string | null }>();

  constructor(private readonly options: ManualSshAllocatorOptions) {
    if (options.hosts.length === 0) {
      throw new Error("ManualSshAllocator requires at least one configured host");
    }
    this.hosts = options.hosts;
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const runnerId = `runner_${request.runId}`;
    const imageSha = `${request.runnerImage}@sha256:manual-ssh`;
    const candidates: PoolLeaseCandidate[] = this.hosts.map((host) => ({
      leaseKey: host.id,
      sshHost: host.host,
      sshPort: host.port ?? 22,
      hostKeyFingerprint: host.hostKeyFingerprint,
      containerId: host.id,
    }));

    // ATOMIC CROSS-PROCESS RESERVATION: the shared store picks a free host under an
    // advisory lock + partial unique index and enforces `maxConcurrent`. A second
    // process contending for the same host / cap is REFUSED here, never
    // double-booked (the pre-#1254 in-memory `busy` set could not see other
    // processes' leases).
    const reservation = await this.options.leases.reservePoolLease({
      runnerId,
      // Persist FK-valid (run_id, project_id), or NULLs for a runless Forge
      // ideation allocation whose synthetic handle is not a real run/project.
      ...persistedRunnerKeys(request),
      orgId: request.orgId ?? null,
      allocator: allocatorName,
      poolKey: manualSshPoolKey,
      owner: this.leaseOwner,
      ...(this.options.maxConcurrent !== undefined && { maxConcurrent: this.options.maxConcurrent }),
      imageSha,
      candidates,
    });

    // The chosen host by its stable id — for the reach fields the store does not
    // carry (username / identity ref). `reservation.leaseKey` came from `candidates`
    // derived from `this.hosts`, so the lookup always resolves.
    const host = this.hosts.find((candidate) => candidate.id === reservation.leaseKey);
    if (host === undefined) {
      throw new Error(`manual-ssh reservation returned an unknown host id ${reservation.leaseKey}`);
    }
    const username = host.username ?? this.options.defaultUsername ?? "tanren";
    const identitySecretRef = host.identitySecretRef ?? request.identitySecretRef;
    this.held.set(runnerId, { fencingToken: reservation.fencingToken });

    return {
      runnerId,
      imageSha,
      target: sshRunnerHandle({
        host: host.host,
        port: reservation.sshPort,
        username,
        hostKeyFingerprint: reservation.hostKeyFingerprint,
        identitySecretRef,
      }),
    };
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const held = this.held.get(runnerId);
    if (held === undefined) {
      // Unknown to this instance (never allocated here, or a process restart lost
      // the fencing token): no-op. A crashed-mid-run lease is reclaimed by the
      // orphan sweeper, not by guessing another owner's fencing token.
      return;
    }
    this.held.delete(runnerId);
    // Manual hosts are long-lived; we never destroy them, only free the fenced lease.
    await this.options.leases.releasePoolLease({
      runnerId,
      owner: this.leaseOwner,
      fencingToken: held.fencingToken,
    });
  }
}
