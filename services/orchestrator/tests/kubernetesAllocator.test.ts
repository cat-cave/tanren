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
  constructor(
    private readonly opts: {
      neverRunning?: boolean;
      noIp?: boolean;
      emptyIp?: boolean;
      terminal?: boolean;
      terminalPhase?: string;
    } = {},
  ) {}

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
      return { name, phase: this.opts.terminalPhase ?? "Failed" };
    }
    if (this.opts.neverRunning) {
      return { name, phase: "Pending" };
    }
    if (this.getCalls < 2) {
      return { name, phase: "Pending" };
    }
    return { name, phase: "Running", podIp: this.opts.noIp ? undefined : this.opts.emptyIp ? "" : "10.1.2.3" };
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
  sleep: async () => {},
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

  it("defaults the SSH username to tanren when none is configured", async () => {
    const client = new FakeKubernetesClient();
    const { sshUsername: _omit, ...rest } = baseOpts(client, new FakeRunnerStore());
    const allocation = await new KubernetesAllocator(rest).allocate(req("run_def"));
    expect(allocation.target.username).toBe("tanren");
  });

  it("honors an explicit SSH username override", async () => {
    const client = new FakeKubernetesClient();
    const allocation = await new KubernetesAllocator({
      ...baseOpts(client, new FakeRunnerStore()),
      sshUsername: "operator",
    }).allocate(req("run_ov"));
    expect(allocation.target.username).toBe("operator");
  });

  it("sanitizes the run id into a pod name and derives the -ssh secret name", async () => {
    const client = new FakeKubernetesClient();
    const allocator = new KubernetesAllocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate(req("Run_ABC/9"));
    const podName = client.pods[0]!.name;
    expect(podName).toBe("tanren-run-abc-9");
    expect(podName).not.toMatch(/[^a-z0-9-]/);
    // The secret name is always the pod name plus the "-ssh" suffix.
    expect(client.secrets[0]!.name).toBe(`${podName}-ssh`);
    expect(client.pods[0]!.sshKeySecretName).toBe(`${podName}-ssh`);
  });

  it("sanitizes label values to the k8s-allowed charset (keeps dots, drops slashes)", async () => {
    const client = new FakeKubernetesClient();
    const allocator = new KubernetesAllocator(baseOpts(client, new FakeRunnerStore()));
    await allocator.allocate(req("Run/With.Dots"));
    // labelValue allows [a-z0-9_.-]; "/" -> "-", "." preserved, lowercased.
    expect(client.pods[0]!.labels["tanren-run"]).toBe("run-with.dots");
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

  // waitForRunning requires Running AND a non-empty pod IP. An empty-string
  // podIP must NOT satisfy the ready condition: a mutant dropping the `ip === ""`
  // arm would return immediately with a bogus empty host. Here the empty IP
  // keeps the wait polling to the deadline, and the pod+secret are cleaned up.
  it("treats an empty-string pod IP as not-yet-ready and cleans up on timeout", async () => {
    const client = new FakeKubernetesClient({ emptyIp: true });
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator({
      ...baseOpts(client, runners),
      readyTimeoutMs: 5,
      pollIntervalMs: 1,
    });
    await expect(allocator.allocate(req("run_empty"))).rejects.toThrow(/did not become Running/);
    expect(client.deletedPods).toContain("tanren-run-empty");
    expect(client.deletedSecrets).toContain("tanren-run-empty-ssh");
    expect(runners.claims).toEqual([]);
  });

  // waitForRunning treats BOTH "Failed" and "Succeeded" as terminal. The
  // terminal test above only exercises "Failed"; pin "Succeeded" so the second
  // arm of the `||` cannot be dropped, and assert the error names the phase.
  it("fails fast naming the terminal phase when the pod reaches Succeeded before Running", async () => {
    const client = new FakeKubernetesClient({ terminal: true, terminalPhase: "Succeeded" });
    const runners = new FakeRunnerStore();
    const allocator = new KubernetesAllocator(baseOpts(client, runners));
    await expect(allocator.allocate(req("run_succ"))).rejects.toThrow(/terminal phase 'Succeeded'/);
    expect(client.deletedPods).toContain("tanren-run-succ");
  });

  it("KubernetesAllocatorError carries the KubernetesAllocatorError name", () => {
    const error = new KubernetesAllocatorError("boom");
    expect(error.name).toBe("KubernetesAllocatorError");
    expect(error).toBeInstanceOf(Error);
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

  // The secret is POSTed to the namespaced secrets collection; pin the URL +
  // method + the Opaque type / namespace in the manifest so the secrets path
  // and manifest fields cannot be silently rewritten.
  it("POSTs the secret to the namespaced secrets path with an Opaque manifest", async () => {
    let captured: { url: string; method?: string; body: Record<string, unknown> } = { url: "", body: {} };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = fetchKubernetesClient(
      { apiServer: "https://h:6443", token: "t", namespace: "runners-ns" },
      fetchImpl,
    );
    await client.createSecret({ name: "s-ssh", sshPublicKey: "ssh-ed25519 KEY", labels: { "tanren-run": "r" } });
    expect(captured.url).toBe("https://h:6443/api/v1/namespaces/runners-ns/secrets");
    expect(captured.method).toBe("POST");
    expect(captured.body.type).toBe("Opaque");
    expect((captured.body.metadata as Record<string, unknown>).namespace).toBe("runners-ns");
  });

  // The pod manifest binds the SSH key Secret to a container env var and exposes
  // the ssh port. Pin the manifest so the env/secretKeyRef wiring + port 22 are
  // behavior-asserted (not just that "secretKeyRef" appears as a substring).
  it("POSTs a pod manifest exposing port 22 and an env secretKeyRef to the ssh secret", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ metadata: { name: "p" }, status: { phase: "Pending" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await client.createPod({ name: "p", image: "img", sshKeySecretName: "p-ssh", labels: {} });
    const spec = body.spec as { restartPolicy: string; containers: Array<Record<string, unknown>> };
    expect(spec.restartPolicy).toBe("Never");
    const container = spec.containers[0]!;
    const ports = container.ports as Array<{ containerPort: number }>;
    expect(ports[0]?.containerPort).toBe(22);
    const env = container.env as Array<{ name: string; valueFrom: { secretKeyRef: { name: string; key: string } } }>;
    expect(env[0]?.valueFrom.secretKeyRef.name).toBe("p-ssh");
    expect(env[0]?.valueFrom.secretKeyRef.key).toBe("ssh-authorized-key");
  });

  // toPod falls back to "Unknown" when the response carries no status phase.
  it("maps a pod with no status to the Unknown phase and no IP", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ metadata: { name: "p" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    const pod = await client.getPod("p");
    expect(pod.phase).toBe("Unknown");
    expect(pod.podIp).toBeUndefined();
  });

  it("DELETEs the secret at the namespaced secrets path", async () => {
    let captured: { url: string; method?: string } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = { url: typeof input === "string" ? input : input.toString(), method: init?.method };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443", token: "t", namespace: "ns" }, fetchImpl);
    await client.deleteSecret("p-ssh");
    expect(captured.url).toBe("https://h:6443/api/v1/namespaces/ns/secrets/p-ssh");
    expect(captured.method).toBe("DELETE");
  });

  // The apiServer base is normalized by stripping trailing slashes so the
  // assembled path is single-slashed.
  it("strips trailing slashes from the apiServer when assembling paths", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      url = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ metadata: { name: "p" }, status: { phase: "Running", podIP: "10.0.0.1" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    const client = fetchKubernetesClient({ apiServer: "https://h:6443//", token: "t", namespace: "ns" }, fetchImpl);
    await client.getPod("p");
    expect(url).toBe("https://h:6443/api/v1/namespaces/ns/pods/p");
  });
});
