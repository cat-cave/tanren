import {
  persistedRunnerKeys,
  sshRunnerHandle,
  type AllocationRequest,
  type Allocator,
  type ReleaseReason,
  type RunnerAllocation,
} from "../contracts/allocator.js";
import { fetchKubernetesClient } from "./kubernetesFetchClient.js";
import { KubernetesAllocatorError, type KubernetesClient, type KubernetesPod } from "./kubernetesShared.js";
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

// The typed error class + minimal-client + pod/condition/container types live in
// `./kubernetesShared.ts` so the production fetch-client and the allocator can
// both import them without a circular dependency. Re-exported here for back-compat
// with existing `import { KubernetesAllocatorError, KubernetesClient, ... } from
// "./kubernetesAllocator.js"` call sites.
export {
  KubernetesAllocatorError,
  type KubernetesClient,
  type KubernetesContainerStatus,
  type KubernetesPod,
  type KubernetesPodCondition,
  type KubernetesPodInput,
  type KubernetesSecretInput,
} from "./kubernetesShared.js";

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
        // Codex H3 #13: persist BOTH the pod name AND the per-run SSH-key
        // Secret's name so a fresh allocator instance (post-restart) can
        // reconstruct both DELETEs — the pod is the compute resource, the
        // Secret is a per-run credential that must be reaped too or it
        // accumulates in the namespace. `container_id` alone (the pod name)
        // would miss the secret and re-introduce the leak on release.
        providerMetadata: { kind: "kubernetes", podName, secretName },
      });
    } catch (error) {
      await this.cleanup(podName, secretName);
      this.resources.delete(runnerId);
      throw error;
    }

    return allocation;
  }

  async release(runnerId: string, _reason: ReleaseReason = "completed"): Promise<void> {
    const resource = await this.resolveResources(runnerId);
    if (resource === undefined) {
      // Already released, unknown to this allocator AND unpersisted, or the
      // persisted row belongs to a different provider (kind mismatch). No-op.
      return;
    }
    this.resources.delete(runnerId);
    await this.client.deletePod(resource.pod);
    await this.client.deleteSecret(resource.secret);
    await this.options.runners.release(runnerId);
  }

  /**
   * Codex H3 #13: resolve the { pod, secret } pair for a release, tolerating
   * the process-restart shape. In-memory first (fast path); DB fallback via
   * `runners.provider_metadata` (durable) when the map has been lost. Both
   * names are needed — the pod carries the compute, the secret carries the
   * per-run SSH credential; a partial teardown would leak the secret.
   */
  private async resolveResources(runnerId: string): Promise<{ pod: string; secret: string } | undefined> {
    const cached = this.resources.get(runnerId);
    if (cached !== undefined) {
      return cached;
    }
    const persisted = await this.options.runners.readTeardownDescriptor(runnerId);
    if (persisted?.kind === "kubernetes") {
      return { pod: persisted.podName, secret: persisted.secretName };
    }
    return undefined;
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

// Pod API response mapping lives in `./kubernetesPodResponse.ts` (the toPod + the
// conditions/containerStatuses summarizers) to keep this file under the line cap.
// Pod + Secret manifests live in `./kubernetesManifests.ts` for the same reason.

// --- production client -------------------------------------------------------

// `fetchKubernetesClient` lives in `./kubernetesFetchClient.ts` to keep this file
// under the 500-line cap. Re-exported here so existing call sites keep their
// `import { fetchKubernetesClient } from "./kubernetesAllocator.js"` working.
export { fetchKubernetesClient } from "./kubernetesFetchClient.js";
