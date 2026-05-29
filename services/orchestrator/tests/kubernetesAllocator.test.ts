import { describe, expect, it } from "vitest";
import {
  fetchKubernetesClient,
  KubernetesAllocator,
  KubernetesAllocatorError,
  type KubernetesClient,
  type KubernetesPod,
  type KubernetesPodInput,
  type KubernetesSecretInput,
} from "../src/engine/allocators/kubernetesAllocator.js";
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";

class FakeRunnerStore implements RunnerStore {
  readonly claims: ClaimRunnerInput[] = [];
  readonly releases: string[] = [];
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claims.push(input);
  }
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
}

/**
 * Mocked Kubernetes API: createPod returns a `Pending` Pod; getPod is `Pending`
 * once then `Running` with a Pod IP.
 */
class FakeKubernetesClient implements KubernetesClient {
  readonly secrets: KubernetesSecretInput[] = [];
  readonly pods: KubernetesPodInput[] = [];
  readonly deletedPods: string[] = [];
  readonly deletedSecrets: string[] = [];
  private getCalls = 0;
  constructor(private readonly opts: { neverRunning?: boolean; noIp?: boolean; terminal?: boolean } = {}) {}

  async createSecret(input: KubernetesSecretInput): Promise<void> {
    this.secrets.push(input);
  }
  async createPod(input: KubernetesPodInput): Promise<KubernetesPod> {
    this.pods.push(input);
    return { name: input.name, phase: "Pending" };
  }
  async getPod(name: string): Promise<KubernetesPod> {
    this.getCalls += 1;
    if (this.opts.terminal) {
      return { name, phase: "Failed" };
    }
    if (this.opts.neverRunning) {
      return { name, phase: "Pending" };
    }
    if (this.getCalls < 2) {
      return { name, phase: "Pending" };
    }
    return { name, phase: "Running", podIp: this.opts.noIp ? undefined : "10.1.2.3" };
  }
  async deletePod(name: string): Promise<void> {
    this.deletedPods.push(name);
  }
  async deleteSecret(name: string): Promise<void> {
    this.deletedSecrets.push(name);
  }
}

const baseOpts = (client: KubernetesClient, runners: RunnerStore) => ({
  apiServer: "https://10.0.0.1:6443",
  token: "sa-token",
  namespace: "tanren-runners",
  runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
  sshPublicKey: "ssh-ed25519 AAAA...",
  sshUsername: "tanren",
  hostKeyFingerprint: "SHA256:k8s",
  runners,
  client,
  sleep: async () => undefined,
});

function req(runId: string) {
  return {
    runId,
    projectId: "proj_k8s",
    runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
    identitySecretRef: "runner/identity",
  };
}

describe("KubernetesAllocator", () => {
  it("creates a secret + pod, waits until Running + IP, and returns the SSH target", async () => {
    const client = new FakeKubernetesClient();
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));

    const allocation = await allocator.allocate(req("run_1"));

    expect(client.secrets).toHaveLength(1);
    expect(client.secrets[0]?.sshPublicKey).toBe("ssh-ed25519 AAAA...");
    expect(client.pods).toHaveLength(1);
    expect(client.pods[0]?.image).toBe("ghcr.io/cat-cave/tanren-runner:v0");
    expect(client.pods[0]?.sshKeySecretName).toBe(client.secrets[0]?.name);
    expect(client.pods[0]?.labels["tanren-run"]).toBe("run_1");
    expect(client.pods[0]?.labels["tanren-project"]).toBe("proj_k8s");
    expect(allocation.target.host).toBe("10.1.2.3");
    expect(allocation.target.port).toBe(22);
    expect(allocation.target.username).toBe("tanren");
    expect(allocation.target.hostKeyFingerprint).toBe("SHA256:k8s");
    expect(allocation.target.identitySecretRef).toBe("runner/identity");
    expect(runners.claims[0]?.allocator).toBe("kubernetes");
    expect(runners.claims[0]?.containerId).toBe(client.pods[0]?.name);
  });

  it("deletes the pod + secret and clears the mirror row on release", async () => {
    const client = new FakeKubernetesClient();
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2"));
    await allocator.release(allocation.runnerId, "completed");
    expect(client.deletedPods).toEqual([client.pods[0]?.name]);
    expect(client.deletedSecrets).toEqual([client.secrets[0]?.name]);
    expect(runners.releases).toEqual([allocation.runnerId]);
  });

  it("release is idempotent: releasing twice deletes only once", async () => {
    const client = new FakeKubernetesClient();
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    const allocation = await allocator.allocate(req("run_2b"));
    await allocator.release(allocation.runnerId);
    await allocator.release(allocation.runnerId);
    expect(client.deletedPods).toHaveLength(1);
    expect(client.deletedSecrets).toHaveLength(1);
  });

  it("release of an unknown runner is a no-op", async () => {
    const client = new FakeKubernetesClient();
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    await allocator.release("runner_unknown");
    expect(client.deletedPods).toEqual([]);
    expect(client.deletedSecrets).toEqual([]);
  });

  it("surfaces a typed error and cleans up if the pod never becomes Running", async () => {
    const client = new FakeKubernetesClient({ neverRunning: true });
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_3"))).rejects.toThrow(/did not become Running/);
    expect(client.deletedPods).toContain("tanren-run-3");
    expect(client.deletedSecrets).toContain("tanren-run-3-ssh");
  });

  it("surfaces a typed error and cleans up if the pod hits a terminal phase", async () => {
    const client = new FakeKubernetesClient({ terminal: true });
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_t"))).rejects.toBeInstanceOf(KubernetesAllocatorError);
    expect(client.deletedPods).toContain("tanren-run-t");
  });

  it("surfaces a typed error and cleans up if it has no pod IP", async () => {
    const client = new FakeKubernetesClient({ noIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_4"))).rejects.toBeInstanceOf(KubernetesAllocatorError);
    expect(client.deletedPods).toContain("tanren-run-4");
  });

  it("requires apiServer/token, namespace, sshPublicKey, and a pinned fingerprint", () => {
    const runners = new FakeRunnerStore();
    const c = new FakeKubernetesClient();
    expect(() => new KubernetesAllocator({ ...baseOpts(c, runners), apiServer: "" })).toThrow(
      /non-empty apiServer and token/,
    );
    expect(() => new KubernetesAllocator({ ...baseOpts(c, runners), token: "" })).toThrow(
      /non-empty apiServer and token/,
    );
    expect(() => new KubernetesAllocator({ ...baseOpts(c, runners), namespace: "" })).toThrow(/non-empty namespace/);
    expect(() => new KubernetesAllocator({ ...baseOpts(c, runners), sshPublicKey: "" })).toThrow(
      /non-empty sshPublicKey/,
    );
    expect(() => new KubernetesAllocator({ ...baseOpts(c, runners), hostKeyFingerprint: "" })).toThrow(
      /pinned hostKeyFingerprint/,
    );
  });

  it("deletes the pod + secret if the runner store claim fails", async () => {
    const client = new FakeKubernetesClient();
    const runners = new FakeRunnerStore();
    runners.claim = async () => {
      throw new Error("claim conflict");
    };
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_c"))).rejects.toThrow(/claim conflict/);
    expect(client.deletedPods).toContain("tanren-run-c");
    expect(client.deletedSecrets).toContain("tanren-run-c-ssh");
  });
});

describe("fetchKubernetesClient", () => {
  const runningPod = JSON.stringify({
    metadata: { name: "tanren-run_1" },
    status: { phase: "Running", podIP: "10.1.2.3" },
  });

  it("POSTs the pod manifest with a bearer token and maps the response", async () => {
    let captured: { url: string; method?: string; auth?: string; body?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      captured = {
        url,
        method: init?.method,
        auth: headers?.authorization,
        body: init?.body as string,
      };
      return new Response(runningPod, {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = fetchKubernetesClient(
      { apiServer: "https://10.0.0.1:6443", token: "sa-token", namespace: "tanren-runners" },
      fetchImpl,
    );
    const pod = await client.createPod({
      name: "tanren-run_1",
      image: "img",
      sshKeySecretName: "tanren-run_1-ssh",
      labels: { "tanren-run": "run_1" },
    });

    expect(captured.url).toBe("https://10.0.0.1:6443/api/v1/namespaces/tanren-runners/pods");
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer sa-token");
    expect(captured.body).toContain("secretKeyRef");
    expect(captured.body).toContain("tanren-run_1-ssh");
    expect(pod).toEqual({ name: "tanren-run_1", phase: "Running", podIp: "10.1.2.3" });
  });

  it("GETs a pod and maps phase + podIP", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(runningPod, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchKubernetesClient(
      { apiServer: "https://10.0.0.1:6443", token: "t", namespace: "ns" },
      fetchImpl,
    );
    const pod = await client.getPod("tanren-run_1");
    expect(url).toBe("https://10.0.0.1:6443/api/v1/namespaces/ns/pods/tanren-run_1");
    expect(pod.phase).toBe("Running");
    expect(pod.podIp).toBe("10.1.2.3");
  });

  it("treats a 404 on delete as success (idempotent destroy)", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("gone", { status: 404 })) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await expect(client.deletePod("p")).resolves.toBeUndefined();
    await expect(client.deleteSecret("s")).resolves.toBeUndefined();
  });

  it("throws a typed error on a non-404 delete failure", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("boom", { status: 500 })) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await expect(client.deletePod("p")).rejects.toBeInstanceOf(KubernetesAllocatorError);
  });

  it("throws a typed error when createPod fails", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("forbidden", { status: 403 })) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await expect(
      client.createPod({ name: "p", image: "img", sshKeySecretName: "s", labels: {} }),
    ).rejects.toBeInstanceOf(KubernetesAllocatorError);
  });

  it("creates the secret with the ssh public key in stringData", async () => {
    let body = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      body = init?.body as string;
      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await client.createSecret({ name: "s", sshPublicKey: "ssh-ed25519 KEY", labels: {} });
    expect(body).toContain("ssh-authorized-key");
    expect(body).toContain("ssh-ed25519 KEY");
  });
});
