import { describe, expect, it } from "vitest";
import {
  SidecarAllocateTransportError,
  SidecarHttpAllocator,
  SidecarReleaseTransportError,
} from "../src/engine/allocators/sidecarHttpAllocator.js";
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

/** Build a 2xx JSON `Response` from a body object — hoisted to module scope so the
 * lint's `consistent-function-scoping` doesn't fire when several `it` blocks share it. */
const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch stub returning a fixed happy-path /allocate response. */
const makeAllocateFetch = (): typeof fetch =>
  (async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        runnerId: "runner_u",
        sshHost: "h",
        sshPort: 22,
        hostKeyFingerprint: "SHA256:y",
        imageSha: "sha256:z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

describe("SidecarHttpAllocator", () => {
  it("POSTs /allocate with the bearer token and leaves row persistence to the sidecar", async () => {
    let captured: {
      url: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = { url: "" };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      captured = {
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response(
        JSON.stringify({
          runnerId: "runner_run_1",
          sshHost: "tanren-runner-run_1",
          sshPort: 22,
          hostKeyFingerprint: "SHA256:test",
          imageSha: "sha256:fake",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const runners = new FakeRunnerStore();
    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200",
      authToken: "supersecret",
      runners,
      fetchImpl,
    });

    const result = await allocator.allocate({
      runId: "run_1",
      projectId: "proj_a",
      orgId: "org_1",
      runnerImage: "ghcr.io/cat-cave/tanren-runner:v0",
      identitySecretRef: "runner/identity",
    });

    expect(captured.url).toBe("http://allocator:3200/allocate");
    expect(captured.method).toBe("POST");
    expect(captured.headers?.authorization).toBe("Bearer supersecret");
    const sentBody = JSON.parse(captured.body ?? "{}") as Record<string, unknown>;
    expect(sentBody.runId).toBe("run_1");
    // SYSTEM-vs-USERLAND split: NO secret ref or value is ever sent to the
    // sidecar. The orchestrator's SSH private key (`identitySecretRef`) stays in
    // the returned target handle ONLY; the allocator has no secret-store access
    // and delivers no secret to the runner via Docker env. The POST body carries
    // no `vaultRefs` and no ref string anywhere.
    expect("vaultRefs" in sentBody).toBe(false);
    expect(JSON.stringify(sentBody)).not.toContain("runner/identity");
    // De-priv: the run's org is threaded into the /allocate POST body so the
    // service writes the `runners` row under that org's RLS scope.
    expect(sentBody.orgId).toBe("org_1");

    expect(result.runnerId).toBe("runner_run_1");
    expect(result.target.host).toBe("tanren-runner-run_1");
    // The identity ref still rides the returned target handle — that is how the
    // orchestrator's SSH substrate reaches the runner.
    expect(result.target.identitySecretRef).toBe("runner/identity");
    // The allocator sidecar already persisted the `runners` row under org RLS;
    // the orchestrator client must not double-insert the same primary key.
    expect(runners.claims).toHaveLength(0);
  });

  it("posts /release with the reason and clears the mirror row", async () => {
    let releaseCalls = 0;
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/release")) {
        releaseCalls += 1;
        return new Response(JSON.stringify({ released: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected call: ${url}`);
    }) as typeof fetch;

    const runners = new FakeRunnerStore();
    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200/",
      authToken: "t",
      runners,
      fetchImpl,
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
      fetchImpl,
    });
    await expect(
      allocator.allocate({
        runId: "run_err",
        projectId: "p",
        runnerImage: "img",
        identitySecretRef: "r",
      }),
    ).rejects.toThrow(/allocate failed/u);
  });

  it("strips a trailing slash from baseUrl so the path is single-slashed", async () => {
    let allocateUrl = "";
    let releaseUrl = "";
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/release")) {
        releaseUrl = url;
        return new Response(JSON.stringify({ released: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      allocateUrl = url;
      return new Response(
        JSON.stringify({
          runnerId: "runner_x",
          sshHost: "h",
          sshPort: 22,
          hostKeyFingerprint: "SHA256:y",
          imageSha: "sha256:z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const allocator = new SidecarHttpAllocator({
      baseUrl: "http://allocator:3200/",
      authToken: "t",
      runners: new FakeRunnerStore(),
      fetchImpl,
    });
    const alloc = await allocator.allocate({
      runId: "r",
      projectId: "p",
      runnerImage: "img",
      identitySecretRef: "ref",
    });
    await allocator.release(alloc.runnerId);
    expect(allocateUrl).toBe("http://allocator:3200/allocate");
    expect(releaseUrl).toBe("http://allocator:3200/release");
  });

  it("defaults the SSH username to tanren and honors an override", async () => {
    const reqInput = { runId: "r", projectId: "p", runnerImage: "img", identitySecretRef: "ref" };

    const defaulted = await new SidecarHttpAllocator({
      baseUrl: "http://a:1",
      authToken: "t",
      runners: new FakeRunnerStore(),
      fetchImpl: makeAllocateFetch(),
    }).allocate(reqInput);
    expect(defaulted.target.username).toBe("tanren");

    const overridden = await new SidecarHttpAllocator({
      baseUrl: "http://a:1",
      authToken: "t",
      sshUsername: "operator",
      runners: new FakeRunnerStore(),
      fetchImpl: makeAllocateFetch(),
    }).allocate(reqInput);
    expect(overridden.target.username).toBe("operator");
  });

  it("never puts a secret ref in the /allocate body (the env-bundle channel is gone)", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          runnerId: "runner_d",
          sshHost: "h",
          sshPort: 22,
          hostKeyFingerprint: "SHA256:y",
          imageSha: "sha256:z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    await new SidecarHttpAllocator({
      baseUrl: "http://a:1",
      authToken: "t",
      runners: new FakeRunnerStore(),
      fetchImpl,
    }).allocate({
      runId: "r",
      projectId: "p",
      orgId: "org_x",
      runnerImage: "img",
      // The orchestrator's SSH private key ref — must NOT appear anywhere in the
      // body. The allocator never resolves a secret value; runner creds arrive via
      // the SSH file substrate after allocation.
      identitySecretRef: "runner/identity",
    });
    expect("vaultRefs" in sentBody).toBe(false);
    expect(JSON.stringify(sentBody)).not.toContain("runner/identity");
    // The body is purely naming/orchestration metadata.
    expect(Object.keys(sentBody).sort()).toEqual(["orgId", "projectId", "runId", "runnerImage"]);
  });

  // /release is a POST to the release path carrying { runnerId, reason } as the
  // JSON body and the bearer + content-type headers. Pin all of these so the
  // method, path, body fields, and the propagated reason are behavior-asserted.
  it("POSTs /release with the runnerId + reason body and auth/content-type headers", async () => {
    let captured: { url: string; method?: string; body: Record<string, unknown>; headers: Record<string, string> } = {
      url: "",
      body: {},
      headers: {},
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response(JSON.stringify({ released: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const runners = new FakeRunnerStore();
    await new SidecarHttpAllocator({ baseUrl: "http://allocator:3200", authToken: "sek", runners, fetchImpl }).release(
      "runner_rel",
      "abandoned",
    );
    expect(captured.url).toBe("http://allocator:3200/release");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ runnerId: "runner_rel", reason: "abandoned" });
    expect(captured.headers.authorization).toBe("Bearer sek");
    expect(captured.headers["Content-Type"]).toBe("application/json");
    expect(runners.releases).toEqual(["runner_rel"]);
  });

  // release defaults the reason to "completed" when the caller omits it.
  it("defaults the release reason to completed when omitted", async () => {
    let reason: unknown;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      reason = (JSON.parse(String(init?.body)) as { reason: string }).reason;
      return new Response(JSON.stringify({ released: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    await new SidecarHttpAllocator({
      baseUrl: "http://a:1",
      authToken: "t",
      runners: new FakeRunnerStore(),
      fetchImpl,
    }).release("runner_def");
    expect(reason).toBe("completed");
  });

  it("does not clear the mirror row when the sidecar reports released=false", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ released: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const runners = new FakeRunnerStore();
    await new SidecarHttpAllocator({ baseUrl: "http://a:1", authToken: "t", runners, fetchImpl }).release(
      "runner_keep",
    );
    expect(runners.releases).toEqual([]);
  });

  it("throws when the sidecar /release response is not 2xx", async () => {
    const fetchImpl = (async (): Promise<Response> => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(
      new SidecarHttpAllocator({
        baseUrl: "http://a:1",
        authToken: "t",
        runners: new FakeRunnerStore(),
        fetchImpl,
      }).release("runner_x"),
    ).rejects.toThrow(/release failed/u);
  });

  // Audit C2 §9: parse-on-receive at the HTTP boundary. A malformed 2xx body
  // from the sidecar previously trusted the unchecked `as` cast and silently
  // propagated undefined fields into a `RunnerAllocation` (SSH-to-`undefined`)
  // or dropped `released` on /release (mirror row never cleared → runner leak).
  // These tests pin the FAIL-LOUD behavior at the boundary.
  describe("audit C2 §9 — parse-on-receive at the HTTP boundary", () => {
    it("throws SidecarAllocateTransportError on a malformed /allocate 2xx body (missing sshHost)", async () => {
      const fetchImpl = (async (): Promise<Response> =>
        okResponse({
          runnerId: "runner_x",
          // sshHost missing on purpose — the old cast would leave `body.sshHost`
          // undefined and propagate that through to the returned target.
          sshPort: 22,
          hostKeyFingerprint: "SHA256:y",
          imageSha: "sha256:z",
        })) as typeof fetch;

      const runners = new FakeRunnerStore();
      const allocator = new SidecarHttpAllocator({
        baseUrl: "http://a:1",
        authToken: "t",
        runners,
        fetchImpl,
      });

      let caught: unknown;
      try {
        await allocator.allocate({
          runId: "r",
          projectId: "p",
          runnerImage: "img",
          identitySecretRef: "ref",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SidecarAllocateTransportError);
      expect((caught as SidecarAllocateTransportError).issues.length).toBeGreaterThan(0);
      // Redacted preview: keys are visible, values are not.
      expect((caught as SidecarAllocateTransportError).payloadPreview).toContain("runnerId");
      expect((caught as SidecarAllocateTransportError).payloadPreview).not.toContain("runner_x");
      // The claim never wrote the DB mirror because allocation failed loud.
      expect(runners.claims).toHaveLength(0);
    });

    it("throws SidecarAllocateTransportError when sshPort is not a number", async () => {
      const fetchImpl = (async (): Promise<Response> =>
        okResponse({
          runnerId: "runner_x",
          sshHost: "h",
          sshPort: "not-a-port",
          hostKeyFingerprint: "SHA256:y",
          imageSha: "sha256:z",
        })) as typeof fetch;
      const allocator = new SidecarHttpAllocator({
        baseUrl: "http://a:1",
        authToken: "t",
        runners: new FakeRunnerStore(),
        fetchImpl,
      });
      await expect(
        allocator.allocate({
          runId: "r",
          projectId: "p",
          runnerImage: "img",
          identitySecretRef: "ref",
        }),
      ).rejects.toBeInstanceOf(SidecarAllocateTransportError);
    });

    it("throws SidecarReleaseTransportError on a malformed /release 2xx body (missing released)", async () => {
      const fetchImpl = (async (): Promise<Response> => okResponse({ notReleased: true })) as typeof fetch;
      const runners = new FakeRunnerStore();
      const allocator = new SidecarHttpAllocator({
        baseUrl: "http://a:1",
        authToken: "t",
        runners,
        fetchImpl,
      });

      let caught: unknown;
      try {
        await allocator.release("runner_leaked");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SidecarReleaseTransportError);
      expect((caught as SidecarReleaseTransportError).issues.length).toBeGreaterThan(0);
      expect((caught as SidecarReleaseTransportError).payloadPreview).toContain("notReleased");
      // The old bug: `body.released` was undefined → `if (body.released)` was
      // false → the mirror was never cleared → runner leaked as "allocated".
      // The fix: the boundary throws BEFORE the runners store is touched. In
      // both the old-bug and the new-throw case the store write is skipped;
      // the difference is that the throw is now VISIBLE.
      expect(runners.releases).toEqual([]);
    });

    it("throws SidecarReleaseTransportError when released is a non-boolean", async () => {
      const fetchImpl = (async (): Promise<Response> => okResponse({ released: "yes" })) as typeof fetch;
      await expect(
        new SidecarHttpAllocator({
          baseUrl: "http://a:1",
          authToken: "t",
          runners: new FakeRunnerStore(),
          fetchImpl,
        }).release("runner_x"),
      ).rejects.toBeInstanceOf(SidecarReleaseTransportError);
    });

    it("parses a well-formed /allocate reply correctly (regression pin)", async () => {
      const fetchImpl = (async (): Promise<Response> =>
        okResponse({
          runnerId: "runner_ok",
          sshHost: "ssh-host",
          sshPort: 22,
          hostKeyFingerprint: "SHA256:ok",
          imageSha: "sha256:ok",
        })) as typeof fetch;
      const allocation = await new SidecarHttpAllocator({
        baseUrl: "http://a:1",
        authToken: "t",
        runners: new FakeRunnerStore(),
        fetchImpl,
      }).allocate({ runId: "r", projectId: "p", runnerImage: "img", identitySecretRef: "ref" });
      expect(allocation.runnerId).toBe("runner_ok");
      expect(allocation.target.host).toBe("ssh-host");
      expect(allocation.target.port).toBe(22);
    });
  });
});
