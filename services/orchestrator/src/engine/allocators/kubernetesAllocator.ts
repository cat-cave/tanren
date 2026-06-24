import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import {
  PersistentProvisioningOutageError,
  ProvisioningTerminalStateError,
  UnknownProvisioningStateError,
  pollUntilReady,
  type ReadinessClassification,
} from "./readinessConvergence.js";
import type { RunnerStore } from "./runnerStore.js";

const allocatorName = "kubernetes";

/**
 * Kubernetes documented Pod phases the allocator EXPECTS to see as an intermediate
 * state on the path to `Running`. Anything outside this set OR {@link K8S_TERMINAL_PHASES}
 * is treated as `unknown_state` — fail-closed ratchet (a new k8s phase forces a code
 * change here, never a silent infinite loop). The Pod lifecycle documents:
 * `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`.
 */
const K8S_PROVISIONING_PHASES: ReadonlySet<string> = new Set(["Pending", "Running"]);

/**
 * Kubernetes documented terminal phases — a Pod in these phases cannot recover by
 * waiting (it already completed, succeeded, or failed; `Unknown` means kubelet
 * cannot reach the Pod, which doesn't self-heal as `Running`). Fires the
 * `terminal_error` arm immediately, never via the fixed-point gate.
 */
const K8S_TERMINAL_PHASES: ReadonlySet<string> = new Set(["Failed", "Succeeded", "Unknown"]);

/**
 * Typed error for Kubernetes provisioning failures, so callers (and tests) can
 * distinguish allocator faults from generic errors. Optionally carries a `cause`
 * so a convergence-class throw wrapped into this allocator's error keeps the
 * inner stuck-signature / probe-count diagnostic accessible.
 */
export class KubernetesAllocatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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

/**
 * Kubernetes Pod Condition (per the API). Each is a `type`/`status` pair the
 * scheduler/kubelet evolves through the Pod lifecycle (`PodScheduled` /
 * `Initialized` / `ContainersReady` / `Ready`). The structural signature folds
 * SORTED `type=status` pairs so the kubelet flipping any condition shows as
 * forward motion to the convergence detector.
 */
export interface KubernetesPodCondition {
  type: string;
  /** True | False | Unknown */
  status: string;
  /** Optional human-readable reason for the condition's current status. */
  reason?: string;
}

/**
 * Kubernetes container status as surfaced by the API. The structural signature
 * reads `state.waiting.reason` so distinct waiting reasons (`ImagePullBackOff`
 * vs `ContainerCreating` vs `CrashLoopBackOff`) advance the signature; a
 * kubelet retrying `ImagePullBackOff` keeps the loop running while the cluster
 * is genuinely retrying, and an identical reason stuck past the saturation gate
 * surfaces loud.
 */
export interface KubernetesContainerStatus {
  name: string;
  /** Stable identity of the container's current state: e.g. `waiting:ImagePullBackOff`. */
  state: string;
  /** Optional reason (e.g. `ImagePullBackOff`, `ContainerCreating`). */
  reason?: string;
}

export interface KubernetesPod {
  name: string;
  /** Pending | Running | Succeeded | Failed | Unknown */
  phase: string;
  /** Scheduled Pod IP; empty until the Pod is Running on a node. */
  podIp?: string;
  /**
   * Pod conditions (PodScheduled / Initialized / ContainersReady / Ready). When
   * absent, the structural signature is just `phase|ip-presence`; when present,
   * the signature also folds SORTED `type=status` pairs so the kubelet flipping
   * any condition counts as forward motion.
   */
  conditions?: ReadonlyArray<KubernetesPodCondition>;
  /**
   * Container statuses surfaced by the kubelet. When present, the signature
   * folds SORTED `name:state` pairs so an `ImagePullBackOff` is distinct from
   * a `ContainerCreating` (different state strings = the loop sees forward
   * motion); identical-state recurrence past the saturation gate surfaces loud.
   */
  containerStatuses?: ReadonlyArray<KubernetesContainerStatus>;
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

  /**
   * Wait for the Pod to become `Running` with a Pod IP. CONVERGENCE-BASED: the
   * loop runs UNBOUNDED while the structural signature
   * (`${phase}|${ip-presence}|<sorted conditions>|<sorted container states>`)
   * keeps advancing — so `Pending|no-ip|<no conditions>` → `Pending|no-ip|
   * PodScheduled=True` → `Pending|no-ip|PodScheduled=True,Initialized=True` →
   * `Running|ip|…|ContainersReady=True` is genuine forward motion (the kubelet is
   * making progress). It surfaces LOUD on intelligent non-convergence (the SAME
   * signature past the saturation gate = a wedged Pod, e.g. `ImagePullBackOff`
   * stuck on the same `back-off N restarting failed container` text), a
   * documented terminal phase (`Failed`/`Succeeded`/`Unknown`,
   * `ProvisioningTerminalStateError`), or a brand-new k8s phase the allowlist does
   * not recognize (`UnknownProvisioningStateError`, fail-closed ratchet). NO
   * wall-clock deadline.
   */
  private async waitForRunning(name: string): Promise<KubernetesPod> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 3_000;
    try {
      return await pollUntilReady(() => this.client.getPod(name), {
        classify: (pod) => classifyKubernetesPod(pod),
        signature: (pod) => kubernetesPodSignature(pod),
        pollIntervalMs,
        sleep: this.sleep,
      });
    } catch (error) {
      throw wrapKubernetesProvisioningError(name, error);
    }
  }
}

/**
 * Classify a Kubernetes Pod observation. Terminal phases fire IMMEDIATELY; the
 * provisioning phases drive the convergence loop. The structural signature
 * folds conditions + container statuses so a kubelet retrying `ImagePullBackOff`
 * (which advances `back-off N restarting failed container`) reads as forward
 * motion AS LONG AS the kubelet keeps moving, and converges to a fixed point
 * only when the same condition/container state recurs past the saturation gate.
 */
function classifyKubernetesPod(pod: KubernetesPod): ReadinessClassification<KubernetesPod> {
  if (pod.phase === "Running" && pod.podIp !== undefined && pod.podIp !== "") {
    return { kind: "ready", observation: pod };
  }
  if (K8S_TERMINAL_PHASES.has(pod.phase)) {
    return {
      kind: "terminal_error",
      reason: `kubernetes pod ${pod.name} entered terminal phase '${pod.phase}' before becoming reachable`,
    };
  }
  if (K8S_PROVISIONING_PHASES.has(pod.phase)) {
    return { kind: "advancing", observation: pod };
  }
  return { kind: "unknown_state", state: pod.phase };
}

/**
 * The STRUCTURAL signature the convergence detector reads: Pod phase +
 * IP-presence + SORTED conditions + SORTED container states. Folding the
 * conditions + container-status arrays into a deterministic textual signature
 * lets the convergence detector distinguish a kubelet making real progress
 * (e.g. flipping `PodScheduled=True` then `Initialized=True`) from a wedged
 * Pod (same `ImagePullBackOff` reason across consecutive probes).
 *
 * SORTED so a non-deterministic order from the API (k8s does not guarantee the
 * conditions array ordering across reads) is not spuriously detected as
 * "advancing" forever.
 */
function kubernetesPodSignature(pod: KubernetesPod): string {
  const ipPart = pod.podIp !== undefined && pod.podIp !== "" ? "ip" : "no-ip";
  const conditionsPart =
    pod.conditions === undefined || pod.conditions.length === 0
      ? "no-conds"
      : [...pod.conditions]
          .map((c) => `${c.type}=${c.status}`)
          .sort((a, b) => a.localeCompare(b))
          .join(",");
  const containersPart =
    pod.containerStatuses === undefined || pod.containerStatuses.length === 0
      ? "no-cstats"
      : [...pod.containerStatuses]
          .map((c) => `${c.name}:${c.state}`)
          .sort((a, b) => a.localeCompare(b))
          .join(",");
  return `${pod.phase}|${ipPart}|${conditionsPart}|${containersPart}`;
}

function wrapKubernetesProvisioningError(podName: string, error: unknown): Error {
  if (error instanceof PersistentProvisioningOutageError) {
    return new KubernetesAllocatorError(`kubernetes pod ${podName} did not become Running: ${error.message}`, {
      cause: error,
    });
  }
  if (error instanceof ProvisioningTerminalStateError) {
    return new KubernetesAllocatorError(error.reason, { cause: error });
  }
  if (error instanceof UnknownProvisioningStateError) {
    return new KubernetesAllocatorError(
      `kubernetes pod ${podName} reported an UNKNOWN phase '${error.observedState}' the allocator's allowlist does not recognize`,
      { cause: error },
    );
  }
  return error instanceof Error ? error : new KubernetesAllocatorError(String(error));
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

interface PodConditionResponse {
  type?: string;
  status?: string;
  reason?: string;
}

interface ContainerStateResponse {
  waiting?: { reason?: string };
  running?: unknown;
  terminated?: { reason?: string };
}

interface ContainerStatusResponse {
  name?: string;
  state?: ContainerStateResponse;
}

interface PodStatusResponse {
  phase?: string;
  podIP?: string;
  conditions?: ReadonlyArray<PodConditionResponse> | null;
  containerStatuses?: ReadonlyArray<ContainerStatusResponse> | null;
}

interface PodResponse {
  metadata?: { name?: string };
  status?: PodStatusResponse;
}

function toConditions(
  conditions: ReadonlyArray<PodConditionResponse> | null | undefined,
): ReadonlyArray<KubernetesPodCondition> | undefined {
  if (conditions === null || conditions === undefined || conditions.length === 0) {
    return undefined;
  }
  return conditions
    .filter((c): c is PodConditionResponse & { type: string; status: string } =>
      typeof c.type === "string" && typeof c.status === "string",
    )
    .map((c) => ({
      type: c.type,
      status: c.status,
      ...(c.reason !== undefined ? { reason: c.reason } : {}),
    }));
}

/**
 * Reduce a container's state object to a STABLE one-line identifier the
 * structural signature can fold. `waiting:ImagePullBackOff` is distinct from
 * `waiting:ContainerCreating` is distinct from `running` is distinct from
 * `terminated:Error` — so the kubelet stepping through `ContainerCreating` →
 * `Running` reads as forward motion, but a stuck `ImagePullBackOff` does not.
 */
function summarizeContainerState(state: ContainerStateResponse | undefined): { state: string; reason?: string } {
  if (state === undefined) {
    return { state: "unknown" };
  }
  if (state.waiting !== undefined) {
    return {
      state: state.waiting.reason !== undefined ? `waiting:${state.waiting.reason}` : "waiting",
      ...(state.waiting.reason !== undefined ? { reason: state.waiting.reason } : {}),
    };
  }
  if (state.running !== undefined) {
    return { state: "running" };
  }
  if (state.terminated !== undefined) {
    return {
      state: state.terminated.reason !== undefined ? `terminated:${state.terminated.reason}` : "terminated",
      ...(state.terminated.reason !== undefined ? { reason: state.terminated.reason } : {}),
    };
  }
  return { state: "unknown" };
}

function toContainerStatuses(
  statuses: ReadonlyArray<ContainerStatusResponse> | null | undefined,
): ReadonlyArray<KubernetesContainerStatus> | undefined {
  if (statuses === null || statuses === undefined || statuses.length === 0) {
    return undefined;
  }
  return statuses
    .filter((c): c is ContainerStatusResponse & { name: string } => typeof c.name === "string")
    .map((c) => {
      const summary = summarizeContainerState(c.state);
      return {
        name: c.name,
        state: summary.state,
        ...(summary.reason !== undefined ? { reason: summary.reason } : {}),
      };
    });
}

function toPod(body: PodResponse, fallbackName: string): KubernetesPod {
  const conditions = toConditions(body.status?.conditions);
  const containerStatuses = toContainerStatuses(body.status?.containerStatuses);
  return {
    name: body.metadata?.name ?? fallbackName,
    phase: body.status?.phase ?? "Unknown",
    podIp: body.status?.podIP,
    ...(conditions !== undefined ? { conditions } : {}),
    ...(containerStatuses !== undefined ? { containerStatuses } : {}),
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
