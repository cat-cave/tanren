import { describe, expect, it } from "vitest";
import { SidecarHttpAllocator } from "../src/engine/allocators/sidecarHttpAllocator.js";
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

describe("SidecarHttpAllocator", () => {
  it("POSTs /allocate with the bearer token and mirrors the runner row", async () => {
    let captured: { url: string; method?: string; body?: string; headers?: Record<string, string> } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>
      };
      return new Response(
        JSON.stringify({
          runnerId: "runner_run_1",
          sshHost: "tanren-runner-run_1",
          sshPort: 22,
          hostKeyFingerprint: "SHA256:test",
          imageSha: "sha256:fake"
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const runners = new FakeRunnerStore();
    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200",
      authToken: "supersecret",
      runners,
      fetchImpl
    });

    const result = await allocator.allocate({
      runId: "run_1",
      projectId: "proj_a",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/identity",
      vaultRefs: ["credential/codex"]
    });

    expect(captured.url).toBe("http://allocator:3200/allocate");
    expect(captured.method).toBe("POST");
    expect(captured.headers?.authorization).toBe("Bearer supersecret");
    const sentBody = JSON.parse(captured.body ?? "{}") as { vaultRefs: string[]; runId: string };
    expect(sentBody.runId).toBe("run_1");
    expect(sentBody.vaultRefs).toEqual(["runner/identity", "credential/codex"]);

    expect(result.runnerId).toBe("runner_run_1");
    expect(result.target.host).toBe("tanren-runner-run_1");
    expect(result.target.identitySecretRef).toBe("runner/identity");
    expect(runners.claims).toHaveLength(1);
    expect(runners.claims[0]?.allocator).toBe("sidecar-docker");
  });

  it("posts /release with the reason and clears the mirror row", async () => {
    let releaseCalls = 0;
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/release")) {
        releaseCalls += 1;
        return new Response(JSON.stringify({ released: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected call: ${url}`);
    }) as typeof fetch;

    const runners = new FakeRunnerStore();
    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200/",
      authToken: "t",
      runners,
      fetchImpl
    });

    await allocator.release("runner_run_2", "failed");
    expect(releaseCalls).toBe(1);
    expect(runners.releases).toEqual(["runner_run_2"]);
  });

  it("throws when the sidecar /allocate response is not 2xx", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200",
      authToken: "t",
      runners: new FakeRunnerStore(),
      fetchImpl
    });
    await expect(
      allocator.allocate({
        runId: "run_err",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "r"
      })
    ).rejects.toThrow(/allocate failed/);
  });
});
