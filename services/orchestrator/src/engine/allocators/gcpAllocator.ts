import type { AllocationRequest, Allocator, ReleaseReason, RunnerAllocation } from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "gcp";
const gcpComputeApiBase = "https://compute.googleapis.com/compute/v1";

/**
 * Typed error for GCP Compute Engine provisioning failures, so callers (and
 * tests) can distinguish allocator faults from generic errors.
 */
export class GcpAllocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GcpAllocatorError";
  }
}

/**
 * Minimal injectable HTTP client over the GCP Compute Engine v1 API. Only the
 * shapes the allocator needs are modeled. Tests inject a fake; production uses
 * {@link fetchGcpComputeClient}.
 *
 * GCP provisioning is asynchronous: `insertInstance` returns a zone Operation
 * that must be polled to completion via `getZoneOperation`, after which
 * `getInstance` exposes the RUNNING state and external IP.
 */
export interface GcpComputeClient {
  insertInstance(input: GcpInsertInstanceInput): Promise<GcpOperation>;
  getZoneOperation(operationName: string): Promise<GcpOperation>;
  getInstance(instanceName: string): Promise<GcpInstance>;
  deleteInstance(instanceName: string): Promise<void>;
}

export interface GcpInsertInstanceInput {
  /** Instance name, DNS-1035 safe (lowercase, digits, dashes). */
  name: string;
  /** Machine type short name, e.g. `e2-small`. */
  machineType: string;
  /** Source image, e.g. `projects/cos-cloud/global/images/family/cos-stable`. */
  sourceImage: string;
  /** SSH username authorized on the instance. */
  sshUsername: string;
  /** Runner SSH public key, injected via instance metadata. */
  sshPublicKey: string;
  /** GCE labels applied to the instance (used to trace it back to a run). */
  labels?: Record<string, string>;
}

/** A GCP long-running zone operation. */
export interface GcpOperation {
  name: string;
  /** PENDING | RUNNING | DONE */
  status: string;
  /** Present when the operation failed. */
  error?: string;
}

export interface GcpInstance {
  name: string;
  /** PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED */
  status: string;
  externalIp?: string;
}

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
  /** Max time to wait for the instance to become RUNNING + get an external IP. */
  readyTimeoutMs?: number;
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
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = `tanren-${request.runId}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
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
      await this.client.deleteInstance(name).catch(() => undefined);
      throw error;
    }

    const ip = instance.externalIp;
    if (ip === undefined || ip === "") {
      await this.client.deleteInstance(name).catch(() => undefined);
      throw new GcpAllocatorError(`gcp instance ${name} became RUNNING without an external IP`);
    }

    const port = 22;
    const runnerId = `runner_${request.runId}`;
    this.instances.set(runnerId, name);

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:gcp`,
      target: {
        host: ip,
        port,
        username: this.options.sshUsername,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        identitySecretRef: request.identitySecretRef,
      },
    };

    try {
      await this.options.runners.claim({
        runnerId,
        runId: request.runId,
        projectId: request.projectId,
        allocator: allocatorName,
        sshHost: ip,
        sshPort: port,
        hostKeyFingerprint: this.options.hostKeyFingerprint,
        imageSha: allocation.imageSha,
        containerId: name,
      });
    } catch (error) {
      await this.client.deleteInstance(name).catch(() => undefined);
      this.instances.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const instanceName = this.instances.get(runnerId);
    if (instanceName === undefined) {
      // Already released or unknown to this instance: no-op.
      return;
    }
    this.instances.delete(runnerId);
    await this.client.deleteInstance(instanceName);
    await this.options.runners.release(runnerId);
  }

  private async waitForOperation(operation: GcpOperation): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + readyTimeoutMs;
    let current = operation;
    for (;;) {
      if (current.error !== undefined && current.error !== "") {
        throw new GcpAllocatorError(`gcp insert operation ${current.name} failed: ${current.error}`);
      }
      if (current.status === "DONE") {
        return;
      }
      if (Date.now() >= deadline) {
        throw new GcpAllocatorError(
          `gcp insert operation ${current.name} did not complete within ${readyTimeoutMs}ms ` +
            `(last status: ${current.status})`,
        );
      }
      await this.sleep(pollIntervalMs);
      current = await this.client.getZoneOperation(current.name);
    }
  }

  private async waitForRunning(instanceName: string): Promise<GcpInstance> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const instance = await this.client.getInstance(instanceName);
      if (instance.status === "RUNNING" && instance.externalIp !== undefined && instance.externalIp !== "") {
        return instance;
      }
      if (Date.now() >= deadline) {
        throw new GcpAllocatorError(
          `gcp instance ${instanceName} did not become RUNNING within ${readyTimeoutMs}ms ` +
            `(last status: ${instance.status})`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }
}

/** GCE labels must be lowercase, <=63 chars, [a-z0-9_-]. */
function labelValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 63);
}

interface GcpOperationResponse {
  name: string;
  status: string;
  error?: { errors?: ReadonlyArray<{ message?: string }> | null } | null;
}

interface GcpAccessConfigResponse {
  natIP?: string;
}

interface GcpNetworkInterfaceResponse {
  accessConfigs?: ReadonlyArray<GcpAccessConfigResponse> | null;
}

interface GcpInstanceResponse {
  name: string;
  status: string;
  networkInterfaces?: ReadonlyArray<GcpNetworkInterfaceResponse> | null;
}

function operationErrorOf(error: GcpOperationResponse["error"]): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  const errors = error.errors;
  if (errors === null || errors === undefined || errors.length === 0) {
    return undefined;
  }
  return errors.map((e) => e.message ?? "unknown error").join("; ");
}

function toOperation(body: GcpOperationResponse): GcpOperation {
  return { name: body.name, status: body.status, error: operationErrorOf(body.error) };
}

function externalIpOf(interfaces: ReadonlyArray<GcpNetworkInterfaceResponse> | null | undefined): string | undefined {
  if (interfaces === null || interfaces === undefined) {
    return undefined;
  }
  for (const iface of interfaces) {
    for (const config of iface.accessConfigs ?? []) {
      if (config.natIP !== undefined && config.natIP !== "") {
        return config.natIP;
      }
    }
  }
  return undefined;
}

function toInstance(body: GcpInstanceResponse): GcpInstance {
  return {
    name: body.name,
    status: body.status,
    externalIp: externalIpOf(body.networkInterfaces),
  };
}

/**
 * Production {@link GcpComputeClient} backed by `fetch` against the Compute
 * Engine v1 API. The access token is supplied by the caller (minted from a
 * Vault-resolved service-account ref), never read from the environment here.
 */
export function fetchGcpComputeClient(
  options: Pick<GcpAllocatorOptions, "accessToken" | "project" | "zone">,
  fetchImpl: typeof fetch = fetch,
): GcpComputeClient {
  const { accessToken, project, zone } = options;
  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  } as const;
  const zoneBase = `${gcpComputeApiBase}/projects/${project}/zones/${zone}`;

  return {
    async insertInstance(input: GcpInsertInstanceInput): Promise<GcpOperation> {
      const response = await fetchImpl(`${zoneBase}/instances`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          name: input.name,
          machineType: `zones/${zone}/machineTypes/${input.machineType}`,
          labels: input.labels,
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: { sourceImage: input.sourceImage },
            },
          ],
          networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
          metadata: {
            items: [{ key: "ssh-keys", value: `${input.sshUsername}:${input.sshPublicKey}` }],
          },
        }),
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp insertInstance failed: ${response.status} ${await response.text()}`);
      }
      return toOperation((await response.json()) as GcpOperationResponse);
    },

    async getZoneOperation(operationName: string): Promise<GcpOperation> {
      const response = await fetchImpl(`${zoneBase}/operations/${operationName}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp getZoneOperation failed: ${response.status} ${await response.text()}`);
      }
      return toOperation((await response.json()) as GcpOperationResponse);
    },

    async getInstance(instanceName: string): Promise<GcpInstance> {
      const response = await fetchImpl(`${zoneBase}/instances/${instanceName}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new GcpAllocatorError(`gcp getInstance failed: ${response.status} ${await response.text()}`);
      }
      return toInstance((await response.json()) as GcpInstanceResponse);
    },

    async deleteInstance(instanceName: string): Promise<void> {
      const response = await fetchImpl(`${zoneBase}/instances/${instanceName}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      // 404 means already gone — treat as success (idempotent destroy).
      if (!response.ok && response.status !== 404) {
        throw new GcpAllocatorError(`gcp deleteInstance failed: ${response.status} ${await response.text()}`);
      }
    },
  };
}
