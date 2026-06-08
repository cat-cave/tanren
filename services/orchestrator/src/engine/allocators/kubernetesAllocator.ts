import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "kubernetes";

/**
 * Typed error for Kubernetes provisioning failures, so callers (and tests) can
 * distinguish allocator faults from generic errors.
 */
export class KubernetesAllocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KubernetesAllocatorError";
  }
}

/**
 * Minimal injectable client over the Kubernetes API. Only the shapes the
 * allocator needs are modeled. Tests inject a fake; production uses
 * {@link fetchKubernetesClient}, a thin bearer-token `fetch` client against the
 * API server (no `@kubernetes/client-node` dependency, matching the AWS
 * thin-client approach).
 *
 * Pod scheduling is asynchronous: `createPod` returns immediately with the Pod
 * in the `Pending` phase; `getPod` must be polled until the phase is `Running`
 * with a non-empty `podIP`. The SSH public key is delivered to the Pod via a
 * per-run Secret created with {@link KubernetesClient.createSecret} (referenced
 * as an env var), so no key material is baked into the Pod spec or image.
 */
export interface KubernetesClient {
  createSecret(input: KubernetesSecretInput): Promise<void>;
  createPod(input: KubernetesPodInput): Promise<KubernetesPod>;
  getPod(name: string): Promise<KubernetesPod>;
  deletePod(name: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

export interface KubernetesSecretInput {
  /** Secret name (DNS-1123 safe). */
  name: string;
  /** SSH public key authorized for the runner, surfaced to the Pod via env. */
  sshPublicKey: string;
  /** Labels applied to the Secret (used to trace it back to a run). */
  labels: Readonly<Record<string, string>>;
}

export interface KubernetesPodInput {
  /** Pod name (DNS-1123 safe). */
  name: string;
  /** Runner container image, e.g. `ghcr.io/cat-cave/tanren-runner:v0`. */
  image: string;
  /** Name of the Secret holding the SSH public key (mapped to an env var). */
  sshKeySecretName: string;
  /** Labels applied to the Pod (used to trace it back to a run). */
  labels: Readonly<Record<string, string>>;
}

export interface KubernetesPod {
  name: string;
  /** Pending | Running | Succeeded | Failed | Unknown */
  phase: string;
  /** Scheduled Pod IP; empty until the Pod is Running on a node. */
  podIp?: string;
}

export interface KubernetesAllocatorOptions {
  /** API server base URL, e.g. `https://10.0.0.1:6443`. */
  apiServer: string;
  /**
   * Bearer token for the API server (a ServiceAccount token). Never hardcode;
   * pass a resolved secret (e.g. from a Vault ref) here.
   */
  token: string;
  /** Namespace to create the runner Pod + Secret in. */
  namespace: string;
  /** Runner container image to schedule. */
  runnerImage: string;
  /** SSH public key authorized on the runner, delivered via a per-run Secret. */
  sshPublicKey: string;
  /** SSH username to return in the target (e.g. `tanren`). */
  sshUsername?: string;
  /**
   * Pre-known host key fingerprint to pin. The API does not expose the runner's
   * host key; in production it is baked into the runner image. When unset,
   * allocation fails so we never hand back an unverifiable target.
   */
  hostKeyFingerprint: string;
  /**
   * PEM-encoded CA bundle that signed the API server certificate. Optional for
   * tests / trusted endpoints; production should pin it.
   */
  caPem?: string;
  /** Orchestrator mirror of the runners table. */
  runners: RunnerStore;
  /** Injectable client (tests pass a mock). Defaults to the real fetch client. */
  client?: KubernetesClient;
  /** Poll interval while waiting for the Pod to become Running. */
  pollIntervalMs?: number;
  /** Max time to wait for the Pod to become Running + get a Pod IP. */
  readyTimeoutMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Cloud allocator that schedules a runner Pod on a Kubernetes cluster on demand,
 * waits for it to reach the `Running` phase with a Pod IP, and returns it as an
 * SSH target. Release deletes the Pod and its SSH-key Secret (idempotent). All
 * API calls go through an injectable {@link KubernetesClient} so the lifecycle
 * is unit-tested against a mock with no live cluster.
 *
 * SSH reachability: the returned target's host is the Pod IP and the port is 22.
 * This is the documented in-cluster / pod-network-routable approach — the
 * orchestrator must be able to reach Pod IPs directly (running in-cluster, or
 * with a flat pod network / VPN). A Service / NodePort is intentionally not
 * created: it adds a moving part per run, and the runner Pod is single-tenant
 * and ephemeral, so the Pod IP is the smallest reachable address. Like the
 * other cloud allocators it pins a pre-known host key fingerprint rather than
 * doing TOFU, because production runner images bake a known host key.
 */
export class KubernetesAllocator implements Allocator {
  private readonly client: KubernetesClient;
  private readonly sleep: (ms: number) => Promise<void>;
  /** runnerId -> { pod, secret } names, so release can delete the right ones. */
  private readonly resources = new Map<string, { pod: string; secret: string }>();

  constructor(private readonly options: KubernetesAllocatorOptions) {
    if (options.apiServer === "" || options.token === "") {
      throw new KubernetesAllocatorError("KubernetesAllocator requires a non-empty apiServer and token");
    }
    if (options.namespace === "") {
      throw new KubernetesAllocatorError("KubernetesAllocator requires a non-empty namespace");
    }
    if (options.sshPublicKey === "") {
      throw new KubernetesAllocatorError("KubernetesAllocator requires a non-empty sshPublicKey");
    }
    if (options.hostKeyFingerprint === "") {
      throw new KubernetesAllocatorError("KubernetesAllocator requires a pinned hostKeyFingerprint");
    }
    this.client = options.client ?? fetchKubernetesClient(options);
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    const name = resourceName(request.runId);
    const secretName = `${name}-ssh`;
    const labels = {
      "tanren-run": labelValue(request.runId),
      "tanren-project": labelValue(request.projectId),
    };

    await this.client.createSecret({
      name: secretName,
      sshPublicKey: this.options.sshPublicKey,
      labels,
    });

    let pod: KubernetesPod;
    try {
      await this.client.createPod({
        name,
        image: this.options.runnerImage,
        sshKeySecretName: secretName,
        labels,
      });
      pod = await this.waitForRunning(name);
    } catch (error) {
      await this.cleanup(name, secretName);
      throw error;
    }

    const ip = pod.podIp;
    if (ip === undefined || ip === "") {
      await this.cleanup(name, secretName);
      throw new KubernetesAllocatorError(`kubernetes pod ${name} became Running without a pod IP`);
    }

    return this.claim(request, name, secretName, ip);
  }

  private async claim(
    request: AllocationRequest,
    podName: string,
    secretName: string,
    ip: string,
  ): Promise<RunnerAllocation> {
    const port = 22;
    const username = this.options.sshUsername ?? "tanren";
    const runnerId = `runner_${request.runId}`;
    this.resources.set(runnerId, { pod: podName, secret: secretName });

    const allocation: RunnerAllocation = {
      runnerId,
      imageSha: `${request.runnerImage}@sha256:kubernetes`,
      target: sshRunnerHandle({
        host: ip,
        port,
        username,
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
        containerId: podName,
      });
    } catch (error) {
      await this.cleanup(podName, secretName);
      this.resources.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const resource = this.resources.get(runnerId);
    if (resource === undefined) {
      // Already released or unknown to this allocator: no-op.
      return;
    }
    this.resources.delete(runnerId);
    await this.client.deletePod(resource.pod);
    await this.client.deleteSecret(resource.secret);
    await this.options.runners.release(runnerId);
  }

  /** Best-effort delete of a Pod + Secret so a stuck allocation doesn't leak. */
  private async cleanup(podName: string, secretName: string): Promise<void> {
    await this.client.deletePod(podName).catch(() => {});
    await this.client.deleteSecret(secretName).catch(() => {});
  }

  private async waitForRunning(name: string): Promise<KubernetesPod> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const pod = await this.client.getPod(name);
      if (pod.phase === "Running" && pod.podIp !== undefined && pod.podIp !== "") {
        return pod;
      }
      if (pod.phase === "Failed" || pod.phase === "Succeeded") {
        throw new KubernetesAllocatorError(
          `kubernetes pod ${name} entered terminal phase '${pod.phase}' before becoming reachable`,
        );
      }
      if (Date.now() >= deadline) {
        throw new KubernetesAllocatorError(
          `kubernetes pod ${name} did not become Running within ${readyTimeoutMs}ms (last phase: ${pod.phase})`,
        );
      }
      await this.sleep(pollIntervalMs);
    }
  }
}

/** Pod / Secret names must be DNS-1123 labels: lowercase, digits, dashes, <=63. */
function resourceName(runId: string): string {
  return `tanren-${runId}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .slice(0, 58);
}

/** Kubernetes label values: <=63 chars, alnum plus `-_.`, alnum at the edges. */
function labelValue(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]/gu, "-")
    .slice(0, 63);
}

// --- response mapping --------------------------------------------------------

interface PodStatusResponse {
  phase?: string;
  podIP?: string;
}

interface PodResponse {
  metadata?: { name?: string };
  status?: PodStatusResponse;
}

function toPod(body: PodResponse, fallbackName: string): KubernetesPod {
  return {
    name: body.metadata?.name ?? fallbackName,
    phase: body.status?.phase ?? "Unknown",
    podIp: body.status?.podIP,
  };
}

// --- spec builders -----------------------------------------------------------

function secretManifest(input: KubernetesSecretInput, namespace: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: input.name, namespace, labels: input.labels },
    type: "Opaque",
    stringData: { "ssh-authorized-key": input.sshPublicKey },
  };
}

function podManifest(input: KubernetesPodInput, namespace: string): unknown {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: input.name, namespace, labels: input.labels },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name: "runner",
          image: input.image,
          ports: [{ containerPort: 22, name: "ssh" }],
          env: [
            {
              // Must match the env name the runner entrypoint reads
              // (`runner/entrypoint.sh`: TANREN_RUNNER_AUTHORIZED_KEY) — a
              // mismatch silently leaves the Pod with no authorized_keys and the
              // orchestrator can never SSH in. The PUBLIC authorized_keys line is
              // safe to deliver via a per-run Secret env; the orchestrator's
              // PRIVATE key never transits here.
              name: "TANREN_RUNNER_AUTHORIZED_KEY",
              valueFrom: {
                secretKeyRef: { name: input.sshKeySecretName, key: "ssh-authorized-key" },
              },
            },
          ],
        },
      ],
    },
  };
}

// --- production client -------------------------------------------------------

/**
 * Production {@link KubernetesClient} backed by `fetch` against the API server,
 * authenticated with a bearer token. The token + CA are supplied by the caller
 * (resolved from a Vault ref), never read from the environment here. A thin
 * client is used instead of `@kubernetes/client-node` to keep the allocator
 * small, dependency-free, and injectable/mockable like the AWS allocator.
 *
 * The `caPem` option is accepted for parity with in-cluster config; Node's
 * global fetch validates against the system trust store, so pinning a private
 * CA is an operator concern (e.g. NODE_EXTRA_CA_CERTS) rather than something
 * this thin client wires into each request.
 */
export function fetchKubernetesClient(
  options: Pick<KubernetesAllocatorOptions, "apiServer" | "token" | "namespace" | "caPem">,
  fetchImpl: typeof fetch = fetch,
): KubernetesClient {
  const base = `${options.apiServer.replace(/\/+$/u, "")}/api/v1/namespaces/${options.namespace}`;
  const authHeaders = {
    authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  } as const;

  async function create(resource: string, manifest: unknown, action: string): Promise<PodResponse> {
    const response = await fetchImpl(`${base}/${resource}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(manifest),
    });
    if (!response.ok) {
      throw new KubernetesAllocatorError(`kubernetes ${action} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as PodResponse;
  }

  async function remove(resource: string, name: string, action: string): Promise<void> {
    const response = await fetchImpl(`${base}/${resource}/${name}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    // 404 means already gone — treat as success (idempotent destroy).
    if (!response.ok && response.status !== 404) {
      throw new KubernetesAllocatorError(`kubernetes ${action} failed: ${response.status} ${await response.text()}`);
    }
  }

  return {
    async createSecret(input: KubernetesSecretInput): Promise<void> {
      await create("secrets", secretManifest(input, options.namespace), "createSecret");
    },

    async createPod(input: KubernetesPodInput): Promise<KubernetesPod> {
      return toPod(await create("pods", podManifest(input, options.namespace), "createPod"), input.name);
    },

    async getPod(name: string): Promise<KubernetesPod> {
      const response = await fetchImpl(`${base}/pods/${name}`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!response.ok) {
        throw new KubernetesAllocatorError(`kubernetes getPod failed: ${response.status} ${await response.text()}`);
      }
      return toPod((await response.json()) as PodResponse, name);
    },

    async deletePod(name: string): Promise<void> {
      await remove("pods", name, "deletePod");
    },

    async deleteSecret(name: string): Promise<void> {
      await remove("secrets", name, "deleteSecret");
    },
  };
}
