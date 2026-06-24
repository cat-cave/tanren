// Production {@link KubernetesClient} backed by `fetch` against the API server —
// extracted from `kubernetesAllocator.ts` to keep that file under the 500-line cap.
// A thin client is used instead of `@kubernetes/client-node` to keep the allocator
// small, dependency-free, and injectable/mockable like the AWS allocator.

import type { KubernetesAllocatorOptions } from "./kubernetesAllocator.js";
import { podManifest, secretManifest } from "./kubernetesManifests.js";
import { toPod, type PodResponse } from "./kubernetesPodResponse.js";
import {
  KubernetesAllocatorError,
  type KubernetesClient,
  type KubernetesPod,
  type KubernetesPodInput,
  type KubernetesSecretInput,
} from "./kubernetesShared.js";

/**
 * Production {@link KubernetesClient} backed by `fetch` against the API server,
 * authenticated with a bearer token. The token + CA are supplied by the caller
 * (resolved from a Vault ref), never read from the environment here.
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
