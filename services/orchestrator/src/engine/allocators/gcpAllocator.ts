import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type AllocatorTaxonomy,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import { fetchGcpComputeClient } from "./gcpFetchClient.js";
import { GcpAllocatorError, type GcpComputeClient, type GcpInstance, type GcpOperation } from "./gcpShared.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  pollUntilReady,
  type ReadinessClassification,
} from "./readinessConvergence.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "gcp";

/**
 * GCP documented zone operation statuses. `DONE` is the ready terminus for the
 * operation poll; `PENDING` and `RUNNING` are intermediate. An operation `error`
 * field surfaces as a terminal_error arm immediately.
 */
const GCP_OPERATION_STATUSES: ReadonlySet<string> = new Set(["PENDING", "RUNNING", "DONE"]);

/**
 * GCP documented instance lifecycle statuses the allocator EXPECTS to see as an
 * intermediate state on the path to `RUNNING`. Anything outside this set OR
 * {@link GCP_INSTANCE_TERMINAL_STATUSES} is `unknown_state` — fail-closed ratchet.
 * Compute Engine documents: PROVISIONING, STAGING, RUNNING, STOPPING, STOPPED,
 * SUSPENDING, SUSPENDED, TERMINATED, REPAIRING.
 */
const GCP_INSTANCE_PROVISIONING_STATUSES: ReadonlySet<string> = new Set([
  "PROVISIONING",
  "STAGING",
  "RUNNING",
  "REPAIRING",
]);

/**
 * GCP documented instance terminal statuses — an instance in these states cannot
 * recover by waiting (it has been torn down or is being torn down).
 */
const GCP_INSTANCE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "STOPPING",
  "STOPPED",
  "SUSPENDING",
  "SUSPENDED",
  "TERMINATED",
]);

// The typed error class + minimal-client + types live in `./gcpShared.ts` so the
// production fetch-client and the allocator can both import them without a circular
// dependency. Re-exported here for back-compat with existing imports.
export {
  GcpAllocatorError,
  type GcpComputeClient,
  type GcpInsertInstanceInput,
  type GcpInstance,
  type GcpOperation,
} from "./gcpShared.js";

export interface GcpAllocatorOptions {
  /**
   * OAuth2 bearer access token for the Compute Engine API. Never hardcode;
   * pass a resolved secret (e.g. minted from a service-account JSON ref by the
   * operator's secret tooling) here.
   */
  accessToken: string;
  /** GCP project id that owns the instance. */
  project: string;
  /** Compute zone, e.g. `us-central1-a`. */
  zone: string;
  /** Machine type short name, e.g. `e2-small`. */
  machineType: string;
  /** Source image, e.g. `projects/cos-cloud/global/images/family/cos-stable`. */
  sourceImage: string;
  /** SSH username to authorize and return in the target. */
  sshUsername: string;
  /** Runner SSH public key, injected into instance metadata as `<user>:<key>`. */
  sshPublicKey: string;
  /**
   * Pre-known host key fingerprint to pin. GCP does not expose the host key via
   * the API; in production this is derived from a baked image / startup script
   * that installs a known key. When unset, allocation fails so we never hand
   * back an unverifiable target.
   */
  hostKeyFingerprint: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: GcpComputeClient;
  /** Poll interval while waiting for the operation + instance to become ready. */
  pollIntervalMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cloud allocator that provisions a GCP Compute Engine instance on demand,
 * waits for the insert operation to complete and the instance to reach RUNNING
 * with an external IP, and returns it as an SSH target. Release deletes the
 * instance (idempotent). All API calls go through an injectable
 * {@link GcpComputeClient} so the lifecycle is unit-tested against a mock with
 * no live credentials.
 *
 * Mirrors the DigitalOcean / Hetzner reference allocators: it pins a pre-known
 * host key fingerprint rather than doing TOFU, because production deployments
 * bake a known host key into the image / startup script.
 */
export class GcpAllocator implements Allocator {
  // PROVISIONING: allocate() creates a fresh Compute Engine instance;
  // release() deletes it.
  readonly taxonomy: AllocatorTaxonomy = "provisioning";
  private readonly client: GcpComputeClient;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> GCE instance name, so release can delete the right instance. */
  private readonly instances = new Map<string, string>();

  constructor(private readonly options: GcpAllocatorOptions) {
    if (options.accessToken === "") {
      throw new GcpAllocatorError("GcpAllocator requires a non-empty accessToken");
    }
    if (options.sshPublicKey === "") {
      throw new GcpAllocatorError("GcpAllocator requires a non-empty sshPublicKey");
    }
    if (options.hostKeyFingerprint === "") {
      throw new GcpAllocatorError("GcpAllocator requires a pinned hostKeyFingerprint");
    }
    this.client = options.client ?? fetchGcpComputeClient(options);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/gu, "-")
      .slice(0, 62);
    const operation = await this.client.insertInstance({
      name,
      machineType: this.options.machineType,
      sourceImage: this.options.sourceImage,
      sshUsername: this.options.sshUsername,
      sshPublicKey: this.options.sshPublicKey,
      labels: {
        "tanren-run": labelValue(request.runId),
        "tanren-project": labelValue(request.projectId),
      },
    });

    let instance: GcpInstance;
    try {
      await this.waitForOperation(operation);
      instance = await this.waitForRunning(name);
    } catch (error) {
      // Best-effort delete so a stuck instance doesn't leak.
      await this.client.deleteInstance(name).catch(() => {});
      throw error;
    }

    const ip = instance.externalIp;
    if (ip === undefined || ip === "") {
      await this.client.deleteInstance(name).catch(() => {});
      throw new GcpAllocatorError(`gcp instance ${name} became RUNNING without an external IP`);
    }

    const port = 22;
    const runnerId = `runner_${request.runId}`;
    this.instances.set(runnerId, name);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:gcp`,
      target: sshRunnerHandle({
        host: ip,
        port,
        username: this.options.sshUsername,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
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
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: name,
        // Codex H3 #13: persist the GCE instance name so a fresh allocator
        // instance (post-restart) can reconstruct the DELETE without the
        // in-memory `instances` map.
        providerMetadata: { kind: "gcp", instanceName: name },
      });
    } catch (error) {
      await this.client.deleteInstance(name).catch(() => {});
      this.instances.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const instanceName = await this.resolveInstanceName(runnerId);
    if (instanceName === undefined) {
      // Already released, unknown to this instance AND unpersisted, or the
      // persisted row belongs to a different provider (kind mismatch). No-op.
      return;
    }
    this.instances.delete(runnerId);
    await this.client.deleteInstance(instanceName);
    await this.options.runners.release(runnerId);
  }

  /**
   * Codex H3 #13: resolve the GCE instance name for a release, tolerating the
   * process-restart shape. In-memory first (fast path); DB fallback via
   * `runners.provider_metadata` (durable) when the map has been lost.
   */
  private async resolveInstanceName(runnerId: string): Promise<string | undefined> {
    const cached = this.instances.get(runnerId);
    if (cached !== undefined) {
      return cached;
    }
    const persisted = await this.options.runners.readTeardownDescriptor(runnerId);
    if (persisted?.kind === "gcp") {
      return persisted.instanceName;
    }
    return undefined;
  }

  /**
   * Wait for the GCP zone insert operation to complete. CONVERGENCE-BASED: the
   * loop runs UNBOUNDED while the operation status signature changes
   * (`PENDING` → `RUNNING` → `DONE` = ready). An operation's `error` field fires
   * the `terminal_error` arm IMMEDIATELY. The first probe uses the operation
   * handle the caller already has; subsequent probes refetch.
   */
  private async waitForOperation(operation: GcpOperation): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    let isFirst = true;
    try {
      await pollUntilReady(
        async () => {
          if (isFirst) {
            isFirst = false;
            return operation;
          }
          return this.client.getZoneOperation(operation.name);
        },
        {
          classify: (op) => classifyGcpOperation(op),
          signature: (op) => gcpOperationSignature(op),
          pollIntervalMs,
          sleep: this.sleep,
        },
      );
    } catch (error) {
      throw wrapGcpProvisioningError(`insert operation ${operation.name}`, error);
    }
  }

  /**
   * Wait for the GCP instance to reach `RUNNING` with an external IP.
   * CONVERGENCE-BASED: the loop runs UNBOUNDED while the structural signature
   * (`${status}|${ip-presence}`) keeps advancing — `PROVISIONING|no-ip` →
   * `STAGING|no-ip` → `RUNNING|no-ip` → `RUNNING|ip` (ready). Terminal arms
   * fire IMMEDIATELY; a brand-new GCP status surfaces as `unknown_state`
   * (fail-closed ratchet). NO wall-clock deadline.
   */
  private async waitForRunning(instanceName: string): Promise<GcpInstance> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    try {
      return await pollUntilReady(() => this.client.getInstance(instanceName), {
        classify: (instance) => classifyGcpInstance(instance),
        signature: (instance) => gcpInstanceSignature(instance),
        pollIntervalMs,
        sleep: this.sleep,
      });
    } catch (error) {
      throw wrapGcpProvisioningError(`instance ${instanceName}`, error);
    }
  }
}

/**
 * Classify a GCP zone operation. `DONE` is `ready` (the operation completed
 * successfully). A non-empty `error` field is a `terminal_error` IMMEDIATELY
 * (the operation failed at the cloud — it cannot recover by waiting). `PENDING`
 * / `RUNNING` are `advancing`; anything else is `unknown_state` (fail-closed).
 */
function classifyGcpOperation(operation: GcpOperation): ReadinessClassification<GcpOperation> {
  if (operation.error !== undefined && operation.error !== "") {
    return {
      kind: "terminal_error",
      reason: `gcp insert operation ${operation.name} failed: ${operation.error}`,
    };
  }
  if (operation.status === "DONE") {
    return { kind: "ready", observation: operation };
  }
  if (GCP_OPERATION_STATUSES.has(operation.status)) {
    return { kind: "advancing", observation: operation };
  }
  return { kind: "unknown_state", state: operation.status };
}

/**
 * The STRUCTURAL signature of a GCP zone operation — just the status token
 * (`PENDING` / `RUNNING`). `DONE` resolves as ready before the signature is
 * read, and an error fires terminal IMMEDIATELY, so this is only ever read on
 * `advancing` observations.
 */
function gcpOperationSignature(operation: GcpOperation): string {
  return operation.status;
}

/**
 * Classify a GCP instance observation. Terminal statuses
 * (`STOPPING`/`STOPPED`/`SUSPENDING`/`SUSPENDED`/`TERMINATED`) fire IMMEDIATELY.
 * `PROVISIONING`/`STAGING`/`RUNNING`/`REPAIRING` are `advancing`; only
 * `RUNNING` + external IP is `ready`. A brand-new GCP status string is
 * `unknown_state` (fail-closed).
 */
function classifyGcpInstance(instance: GcpInstance): ReadinessClassification<GcpInstance> {
  if (instance.status === "RUNNING" && instance.externalIp !== undefined && instance.externalIp !== "") {
    return { kind: "ready", observation: instance };
  }
  if (GCP_INSTANCE_TERMINAL_STATUSES.has(instance.status)) {
    return {
      kind: "terminal_error",
      reason: `gcp instance ${instance.name} entered terminal status '${instance.status}' before RUNNING`,
    };
  }
  if (GCP_INSTANCE_PROVISIONING_STATUSES.has(instance.status)) {
    return { kind: "advancing", observation: instance };
  }
  return { kind: "unknown_state", state: instance.status };
}

/** The STRUCTURAL signature the convergence detector reads — instance status + IP-presence. */
function gcpInstanceSignature(instance: GcpInstance): string {
  const ipPart = instance.externalIp !== undefined && instance.externalIp !== "" ? "ip" : "no-ip";
  return `${instance.status}|${ipPart}`;
}

function wrapGcpProvisioningError(resourceDescription: string, error: unknown): Error {
  if (error instanceof PersistentProvisioningOutageError) {
    return new GcpAllocatorError(`gcp ${resourceDescription} did not become RUNNING: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof ProvisioningTerminalStateError) {
    return new GcpAllocatorError(error.reason, { cause: error });
  }
  if (error instanceof UnknownProvisioningStateError) {
    return new GcpAllocatorError(
      `gcp ${resourceDescription} reported an UNKNOWN status '${error.observedState}' the allocator's allowlist does not recognize`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new GcpAllocatorError(String(error));
}

/** GCE labels must be lowercase, <=63 chars, [a-z0-9_-]. */
function labelValue(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/gu, "-")
    .slice(0, 63);
}

// `fetchGcpComputeClient` (the production fetch-backed client + the response
// mapping helpers) lives in `./gcpFetchClient.ts` to keep this file under the
// line cap. Re-exported here so existing call sites keep their existing import.
export { fetchGcpComputeClient } from "./gcpFetchClient.js";
