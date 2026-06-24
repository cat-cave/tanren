// Task #31: tests for the Kubernetes Pod API response mapper. The convergence-based
// readiness loop folds Pod conditions + container statuses into the structural
// signature, so the mapper MUST surface both verbatim — a stuck `ImagePullBackOff`
// recurring across probes yields an IDENTICAL signature; the kubelet flipping
// `PodScheduled=True` → `Initialized=True` advances the signature.

import { describe, expect, it } from "vitest";
import { fetchKubernetesClient } from "../src/engine/allocators/kubernetesAllocator.js";

describe("kubernetesPodResponse.toPod", () => {
  it("surfaces conditions + container statuses from the Pod status API response", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          metadata: { name: "p" },
          status: {
            phase: "Pending",
            podIP: undefined,
            conditions: [
              { type: "PodScheduled", status: "True" },
              { type: "Initialized", status: "False", reason: "ContainersNotInitialized" },
            ],
            containerStatuses: [{ name: "runner", state: { waiting: { reason: "ContainerCreating" } } }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    const pod = await client.getPod("p");
    expect(pod.conditions).toEqual([
      { type: "PodScheduled", status: "True" },
      { type: "Initialized", status: "False", reason: "ContainersNotInitialized" },
    ]);
    expect(pod.containerStatuses).toEqual([
      { name: "runner", state: "waiting:ContainerCreating", reason: "ContainerCreating" },
    ]);
  });

  it("summarizes a running container state and a terminated container with reason", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          metadata: { name: "p" },
          status: {
            phase: "Running",
            podIP: "10.1.2.3",
            containerStatuses: [
              { name: "runner", state: { running: { startedAt: "2026-01-01T00:00:00Z" } } },
              { name: "sidecar", state: { terminated: { reason: "Error" } } },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    const pod = await client.getPod("p");
    expect(pod.containerStatuses).toEqual([
      { name: "runner", state: "running" },
      { name: "sidecar", state: "terminated:Error", reason: "Error" },
    ]);
  });

  it("omits conditions + containerStatuses when the API response carries neither", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ metadata: { name: "p" }, status: { phase: "Pending" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    const pod = await client.getPod("p");
    expect(pod.conditions).toBeUndefined();
    expect(pod.containerStatuses).toBeUndefined();
  });
});
