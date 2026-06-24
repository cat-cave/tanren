// Shared types + error class for the Kubernetes allocator. Extracted from
// `kubernetesAllocator.ts` so the production fetch client (`kubernetesFetchClient.ts`)
// can import them without a circular `allocator ↔ client` dependency (the allocator's
// constructor uses the client; the client's response mapping uses the allocator's
// types — both sides now depend on this shared module, neither on the other).

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
 * `fetchKubernetesClient`, a thin bearer-token `fetch` client against the
 * API server (no `@kubernetes/client-node` dependency).
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
 * vs `ContainerCreating` vs `CrashLoopBackOff`) advance the signature.
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
