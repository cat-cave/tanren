// Kubernetes Pod API response mapping — extracted from `kubernetesAllocator.ts` to
// keep that file under the 500-line cap. The convergence-based readiness loop reads
// the STRUCTURAL signature of conditions + containerStatuses, so the API mapper
// surfaces both fields verbatim (sorted into a stable signature later in the
// allocator's `kubernetesPodSignature`).

import type { KubernetesContainerStatus, KubernetesPod, KubernetesPodCondition } from "./kubernetesShared.js";

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

export interface PodResponse {
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
    .filter(
      (c): c is PodConditionResponse & { type: string; status: string } =>
        typeof c.type === "string" && typeof c.status === "string",
    )
    .map((c) => ({
      type: c.type,
      status: c.status,
      ...(c.reason === undefined ? {} : { reason: c.reason }),
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
      state: state.waiting.reason === undefined ? "waiting" : `waiting:${state.waiting.reason}`,
      ...(state.waiting.reason === undefined ? {} : { reason: state.waiting.reason }),
    };
  }
  if (state.running !== undefined) {
    return { state: "running" };
  }
  if (state.terminated !== undefined) {
    return {
      state: state.terminated.reason === undefined ? "terminated" : `terminated:${state.terminated.reason}`,
      ...(state.terminated.reason === undefined ? {} : { reason: state.terminated.reason }),
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
        ...(summary.reason === undefined ? {} : { reason: summary.reason }),
      };
    });
}

/**
 * Map a Pod API JSON response to the {@link KubernetesPod} the allocator reads.
 * Surfaces `conditions` + `containerStatuses` so the structural readiness signature
 * folds them — a stuck `ImagePullBackOff` vs an advancing `ContainerCreating` is
 * distinguishable to the convergence detector.
 */
export function toPod(body: PodResponse, fallbackName: string): KubernetesPod {
  const conditions = toConditions(body.status?.conditions);
  const containerStatuses = toContainerStatuses(body.status?.containerStatuses);
  return {
    name: body.metadata?.name ?? fallbackName,
    phase: body.status?.phase ?? "Unknown",
    podIp: body.status?.podIP,
    ...(conditions === undefined ? {} : { conditions }),
    ...(containerStatuses === undefined ? {} : { containerStatuses }),
  };
}
